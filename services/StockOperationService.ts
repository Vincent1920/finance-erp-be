import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { db, transaction } from '../config/database'
import type { QueryExecutor } from '../types/database'
import { InventoryRepository } from '../repositories/InventoryRepository'
import { InventoryCostingService } from './InventoryCostingService'
import { NumberSequenceService } from './NumberSequenceService'
import { BusinessValidationService } from './BusinessValidationService'
import { PostingService, type PostingContext } from './PostingService'
import { AuditService } from './AuditService'
import { idempotentOperation } from './IdempotentOperation'
import { ConflictError, NotFoundError, ValidationError } from '../utils/AppError'
import { compareDecimal, subtractDecimal, multiplyDecimal } from '../utils/decimal'
import type { ReversalInput, StockOperationInput } from '../validators/operations.validator'
import { AccountMappingService } from './AccountMappingService'

type StockLine = NonNullable<StockOperationInput['lines']>[number]
const dateOnly = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)

export class StockOperationService {
  async itemUnits(companyId: number, itemId: number) {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT iu.*,u.code,u.name,u.symbol,i.unit_id stock_unit_id
       FROM item_units iu JOIN units u ON u.id=iu.unit_id AND u.company_id=iu.company_id
       JOIN items i ON i.id=iu.item_id AND i.company_id=iu.company_id
       WHERE iu.company_id=? AND iu.item_id=? ORDER BY iu.factor_to_stock,u.code`,
      [companyId, itemId],
    )
    if (!rows.length) throw new NotFoundError('Barang atau satuan barang tidak ditemukan')
    return rows
  }

  saveItemUnits(companyId: number, itemId: number, input: { units: Array<{ unit_id: number; factor_to_stock: number; is_purchase: boolean; is_sales: boolean; barcode?: string | null; is_active: boolean }> }, context: PostingContext) {
    return transaction(async (connection) => {
      const [items] = await connection.execute<RowDataPacket[]>('SELECT id,unit_id FROM items WHERE id=? AND company_id=? AND deleted_at IS NULL FOR UPDATE', [itemId, companyId])
      const item = items[0]
      if (!item) throw new NotFoundError('Barang tidak ditemukan')
      if (new Set(input.units.map((unit) => unit.unit_id)).size !== input.units.length) throw new ValidationError('Satuan barang tidak boleh duplikat')
      const stockUnit = input.units.find((unit) => unit.unit_id === Number(item.unit_id))
      if (!stockUnit || Number(stockUnit.factor_to_stock) !== 1 || !stockUnit.is_active) throw new ValidationError('Satuan stok utama wajib aktif dengan faktor 1')
      const unitIds = input.units.map((unit) => unit.unit_id)
      const [valid] = await connection.execute<RowDataPacket[]>(`SELECT id FROM units WHERE company_id=? AND id IN (${unitIds.map(() => '?').join(',')}) AND is_active=TRUE`, [companyId, ...unitIds])
      if (valid.length !== unitIds.length) throw new ValidationError('Ada satuan yang tidak aktif atau bukan milik perusahaan')
      for (const unit of input.units) await connection.execute(
        `INSERT INTO item_units(company_id,item_id,unit_id,factor_to_stock,is_purchase,is_sales,barcode,is_active)
         VALUES(?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE factor_to_stock=VALUES(factor_to_stock),is_purchase=VALUES(is_purchase),is_sales=VALUES(is_sales),barcode=VALUES(barcode),is_active=VALUES(is_active)`,
        [companyId, itemId, unit.unit_id, unit.factor_to_stock, unit.is_purchase, unit.is_sales, unit.barcode || null, unit.is_active],
      )
      await connection.execute(`UPDATE item_units SET is_active=FALSE WHERE company_id=? AND item_id=? AND unit_id NOT IN (${unitIds.map(() => '?').join(',')})`, [companyId, itemId, ...unitIds])
      await new AuditService().log(connection, { companyId, userId: context.userId, module: 'items', action: 'update', recordType: 'item_units', recordId: itemId, newValue: input, requestId: context.requestId, ip: context.ip })
      return { itemId, saved: input.units.length }
    })
  }

  async list(companyId: number, transfer: boolean) {
    const table = transfer ? 'stock_transfers' : 'stock_adjustments'
    const key = transfer ? 'transfer' : 'adjustment'
    const lineTable = transfer ? 'stock_transfer_lines' : 'stock_adjustment_lines'
    const foreignKey = transfer ? 'stock_transfer_id' : 'stock_adjustment_id'
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT h.id,h.${key}_number number,h.${key}_date date,h.status,h.reference,
       (SELECT COUNT(*) FROM ${lineTable} l WHERE l.${foreignKey}=h.id) line_count
       FROM ${table} h WHERE h.company_id=? ORDER BY h.id DESC`,
      [companyId],
    )
    return rows
  }

  post(companyId: number, transfer: boolean, input: StockOperationInput, context: PostingContext) {
    return idempotentOperation(companyId, input.request_key, transfer ? 'stock-transfer' : 'stock-adjustment', input, async (connection) => {
      const validation = new BusinessValidationService()
      const repo = new InventoryRepository()
      const costing = new InventoryCostingService()
      await validation.ensureOpenPeriod(connection, companyId, input.date)
      await validation.ensureActiveReference(connection, { companyId, table: 'warehouses', id: input.warehouse_id, label: 'Gudang' })
      const lines = this.lines(input)
      const type = transfer ? 'stock_transfer' : 'stock_adjustment'
      const number = await new NumberSequenceService().next(connection, companyId, type, input.date)

      if (transfer) {
        if (!input.to_warehouse_id || input.to_warehouse_id === input.warehouse_id) throw new ValidationError('Pilih gudang tujuan yang berbeda')
        await validation.ensureActiveReference(connection, { companyId, table: 'warehouses', id: input.to_warehouse_id, label: 'Gudang tujuan' })
        const [created] = await connection.execute<ResultSetHeader>(
          `INSERT INTO stock_transfers(company_id,transfer_number,transfer_date,from_warehouse_id,to_warehouse_id,reference,notes,status,created_by) VALUES(?,?,?,?,?,?,?,'draft',?)`,
          [companyId, number, input.date, input.warehouse_id, input.to_warehouse_id, input.reference, input.reason, context.userId],
        )
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index]!
          if (!line.quantity) throw new ValidationError(`Kuantitas baris ${index + 1} wajib diisi`)
          const item = await repo.item(connection, companyId, line.item_id)
          if (!item || item.item_type !== 'inventory') throw new ValidationError(`Barang baris ${index + 1} bukan persediaan aktif`)
          const unit = await this.unit(connection, companyId, line.item_id, line.unit_id ?? Number(item.unit_id))
          const stockQuantity = multiplyDecimal(line.quantity, 4, String(unit.factor_to_stock), 6, 4)
          for (const warehouse of [input.warehouse_id, input.to_warehouse_id].sort((a, b) => a - b)) await repo.lockBalance(connection, companyId, line.item_id, warehouse)
          const common = { companyId, itemId: line.item_id, quantity: stockQuantity, transactionType: type, transactionId: created.insertId, transactionNumber: number, movementDate: input.date, reference: input.reference, userId: context.userId }
          const out = await costing.applyMovement(connection, { ...common, warehouseId: input.warehouse_id, direction: 'out', postingKey: `${type}:${created.insertId}:${index + 1}:out` })
          const incoming = await costing.applyMovement(connection, { ...common, warehouseId: input.to_warehouse_id, direction: 'in', unitCost: out.unitCost, totalCostOverride: out.totalCost, costSlices: out.costSlices, postingKey: `${type}:${created.insertId}:${index + 1}:in` })
          await connection.execute(
            `INSERT INTO stock_transfer_lines(stock_transfer_id,line_number,item_id,quantity,stock_quantity,unit_id,unit_cost,out_movement_id,in_movement_id) VALUES(?,?,?,?,?,?,?,?,?)`,
            [created.insertId, index + 1, line.item_id, line.quantity, stockQuantity, unit.unit_id, out.unitCost, out.movementId, incoming.movementId],
          )
        }
        await connection.execute(`UPDATE stock_transfers SET status='posted',posted_by=?,posted_at=NOW() WHERE id=?`, [context.userId, created.insertId])
        await this.audit(connection, companyId, context, 'stock-transfers', type, created.insertId, number, input, 'post')
        return { id: created.insertId, number, status: 'posted', lineCount: lines.length }
      }

      const [created] = await connection.execute<ResultSetHeader>(
        `INSERT INTO stock_adjustments(company_id,adjustment_number,adjustment_date,warehouse_id,reason,reference,status,created_by) VALUES(?,?,?,?,?,?,'draft',?)`,
        [companyId, number, input.date, input.warehouse_id, input.reason, input.reference, context.userId],
      )
      const journalLines: Array<{ accountId: number; debit: string; credit: string }> = []
      const movementIds: number[] = []
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!
        if (line.actual_quantity === undefined) throw new ValidationError(`Stok aktual baris ${index + 1} wajib diisi`)
        const item = await repo.item(connection, companyId, line.item_id)
        if (!item || item.item_type !== 'inventory') throw new ValidationError(`Barang baris ${index + 1} bukan persediaan aktif`)
        const unit = await this.unit(connection, companyId, line.item_id, line.unit_id ?? Number(item.unit_id))
        const actualStock = multiplyDecimal(line.actual_quantity, 4, String(unit.factor_to_stock), 6, 4)
        const balance = await repo.lockBalance(connection, companyId, line.item_id, input.warehouse_id)
        if (!balance) throw new ConflictError('Saldo stok tidak tersedia')
        const difference = subtractDecimal(actualStock, String(balance.quantity), 4)
        const sign = compareDecimal(difference, '0', 4)
        if (sign === 0) throw new ValidationError(`Stok aktual baris ${index + 1} sama dengan stok sistem`)
        const mappings = new AccountMappingService()
        const inventoryAccountId = await mappings.resolve(connection, companyId, 'INVENTORY', item.inventory_account_id ? Number(item.inventory_account_id) : null)
        const gainLossAccountId = await mappings.resolve(connection, companyId, sign > 0 ? 'STOCK_GAIN' : 'STOCK_LOSS', line.gain_loss_account_id)
        if (inventoryAccountId === gainLossAccountId) throw new ValidationError(`Akun persediaan dan akun selisih baris ${index + 1} harus berbeda`)
        const quantity = sign > 0 ? difference : subtractDecimal('0', difference, 4)
        const unitCost = compareDecimal(String(balance.average_cost), '0', 6) > 0 ? String(balance.average_cost) : line.unit_cost
        if (!unitCost) throw new ValidationError(`Biaya satuan baris ${index + 1} wajib untuk stok pertama`)
        const movement = await costing.applyMovement(connection, { companyId, itemId: line.item_id, warehouseId: input.warehouse_id, direction: sign > 0 ? 'in' : 'out', quantity, unitCost, transactionType: type, transactionId: created.insertId, transactionNumber: number, movementDate: input.date, postingKey: `${type}:${created.insertId}:${index + 1}`, userId: context.userId })
        movementIds.push(movement.movementId)
        if (compareDecimal(movement.totalCost, '0') > 0) {
          journalLines.push({ accountId: inventoryAccountId, debit: sign > 0 ? movement.totalCost : '0', credit: sign > 0 ? '0' : movement.totalCost })
          journalLines.push({ accountId: gainLossAccountId, debit: sign > 0 ? '0' : movement.totalCost, credit: sign > 0 ? movement.totalCost : '0' })
        }
        await connection.execute(
          `INSERT INTO stock_adjustment_lines(stock_adjustment_id,line_number,item_id,unit_id,system_quantity,actual_quantity,difference_quantity,unit_cost,value_difference,gain_loss_account_id,reason,inventory_movement_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          [created.insertId, index + 1, line.item_id, unit.unit_id, balance.quantity, actualStock, difference, movement.unitCost, sign > 0 ? movement.totalCost : subtractDecimal('0', movement.totalCost), gainLossAccountId, input.reason, movement.movementId],
        )
      }
      const journalId = journalLines.length ? await new PostingService().createPostedJournal(connection, { companyId, sourceType: type, sourceId: created.insertId, date: input.date, description: input.reason, reference: number, context, lines: journalLines }) : null
      await connection.execute(`UPDATE stock_adjustments SET status='posted',journal_id=?,posted_by=?,posted_at=NOW() WHERE id=?`, [journalId, context.userId, created.insertId])
      if (movementIds.length) await connection.execute(`UPDATE inventory_movements SET journal_id=? WHERE id IN (${movementIds.map(() => '?').join(',')})`, [journalId, ...movementIds])
      await this.audit(connection, companyId, context, 'stock-adjustments', type, created.insertId, number, { ...input, journalId }, 'post')
      return { id: created.insertId, number, status: 'posted', journalId, lineCount: lines.length }
    })
  }

  reverse(companyId: number, transfer: boolean, id: number, input: ReversalInput, context: PostingContext) {
    return idempotentOperation(companyId, input.request_key, transfer ? 'stock-transfer-reverse' : 'stock-adjustment-reverse', { id, ...input }, async (connection) => {
      const table = transfer ? 'stock_transfers' : 'stock_adjustments'
      const key = transfer ? 'transfer' : 'adjustment'
      const [rows] = await connection.execute<RowDataPacket[]>(`SELECT * FROM ${table} WHERE id=? AND company_id=? FOR UPDATE`, [id, companyId])
      const header = rows[0]
      if (!header) throw new NotFoundError('Dokumen stok tidak ditemukan')
      if (header.status !== 'posted') throw new ConflictError('Hanya dokumen posted yang dapat direversal')
      if (input.date < dateOnly(header[`${key}_date`])) throw new ValidationError('Tanggal reversal tidak boleh sebelum dokumen')
      let reversalJournalId: number | null = null
      if (!transfer && header.journal_id) reversalJournalId = await new PostingService().reversePostedJournal(connection, { companyId, journalId: Number(header.journal_id), date: input.date, reason: input.reason, context, sourceType: 'stock_adjustment_reversal', sourceId: id })
      const lineTable = transfer ? 'stock_transfer_lines' : 'stock_adjustment_lines'
      const foreignKey = transfer ? 'stock_transfer_id' : 'stock_adjustment_id'
      const [lines] = await connection.execute<RowDataPacket[]>(`SELECT * FROM ${lineTable} WHERE ${foreignKey}=? ORDER BY line_number DESC FOR UPDATE`, [id])
      const movementIds: number[] = []
      for (const line of lines) {
        const originals = transfer ? [Number(line.in_movement_id), Number(line.out_movement_id)] : [Number(line.inventory_movement_id)]
        for (const movementId of originals) {
          const reversed = await new InventoryCostingService().reverseMovement(connection, { companyId, movementId, movementDate: input.date, transactionType: `${transfer ? 'stock_transfer' : 'stock_adjustment'}_reversal`, transactionId: id, transactionNumber: String(header[`${key}_number`]), userId: context.userId, reference: input.reason })
          movementIds.push(reversed.movementId)
        }
      }
      if (reversalJournalId && movementIds.length) await connection.execute(`UPDATE inventory_movements SET journal_id=? WHERE id IN (${movementIds.map(() => '?').join(',')})`, [reversalJournalId, ...movementIds])
      if (transfer) await connection.execute(`UPDATE stock_transfers SET status='reversed',reversed_by=?,reversed_at=NOW() WHERE id=?`, [context.userId, id])
      else await connection.execute(`UPDATE stock_adjustments SET status='reversed',reversal_journal_id=?,reversed_by=?,reversed_at=NOW() WHERE id=?`, [reversalJournalId, context.userId, id])
      await this.audit(connection, companyId, context, transfer ? 'stock-transfers' : 'stock-adjustments', transfer ? 'stock_transfer' : 'stock_adjustment', id, String(header[`${key}_number`]), { reason: input.reason, reversalJournalId }, 'reverse')
      return { id, status: 'reversed', reversalJournalId }
    })
  }

  private lines(input: StockOperationInput): StockLine[] {
    return input.lines ?? [{ item_id: input.item_id!, unit_id: input.unit_id, quantity: input.quantity, actual_quantity: input.actual_quantity, gain_loss_account_id: input.gain_loss_account_id, unit_cost: input.unit_cost }]
  }

  private async unit(connection: QueryExecutor, companyId: number, itemId: number, unitId: number) {
    const [rows] = await connection.execute<RowDataPacket[]>('SELECT unit_id,factor_to_stock FROM item_units WHERE company_id=? AND item_id=? AND unit_id=? AND is_active=TRUE', [companyId, itemId, unitId])
    if (!rows[0]) {
      const [items] = await connection.execute<RowDataPacket[]>('SELECT unit_id FROM items WHERE id=? AND company_id=? AND is_active=TRUE AND deleted_at IS NULL', [itemId, companyId])
      if (Number(items[0]?.unit_id) === unitId) return { unit_id: unitId, factor_to_stock: '1.000000' }
      throw new ValidationError('Satuan tidak tersedia untuk barang ini')
    }
    return rows[0]
  }

  private audit(connection: QueryExecutor, companyId: number, context: PostingContext, module: string, recordType: string, recordId: number, recordNumber: string, newValue: unknown, action: 'post' | 'reverse') {
    return new AuditService().log(connection, { companyId, userId: context.userId, module, action, recordType, recordId, recordNumber, newValue, requestId: context.requestId, ip: context.ip })
  }
}
