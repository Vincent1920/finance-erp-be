import type { QueryExecutor } from '../types/database'

import { InventoryRepository } from '../repositories/InventoryRepository'
import { ConflictError, NotFoundError, ValidationError } from '../utils/AppError'
import {
  addDecimal,
  compareDecimal,
  divideDecimal,
  multiplyDecimal,
  normalizeDecimal,
  subtractDecimal,
  type DecimalInput,
} from '../utils/decimal'
import { BusinessValidationService } from './BusinessValidationService'
import { FifoCostingService, type CostSlice } from './FifoCostingService'
import type { RowDataPacket } from 'mysql2/promise'

export interface InventoryMovementInput {
  companyId: number
  itemId: number
  warehouseId: number
  direction: 'in' | 'out'
  quantity: DecimalInput
  unitCost?: DecimalInput
  transactionType: string
  transactionId: number
  sourceLineId?: number | null
  transactionNumber: string
  movementDate: string
  reference?: string | null
  journalId?: number | null
  postingKey: string
  userId: number
  isReversal?: boolean
  reversalMovementId?: number | null
  costSlices?: CostSlice[]
  totalCostOverride?: string
}

export class InventoryCostingService {
  constructor(
    private repository = new InventoryRepository(),
    private validation = new BusinessValidationService(),
  ) {}

  async applyMovement(connection: QueryExecutor, input: InventoryMovementInput) {
    // Shared company lock prevents a method change racing a stock posting.
    await connection.execute('SELECT id FROM companies WHERE id=? LOCK IN SHARE MODE',[input.companyId])
    const [policies]=await connection.execute<RowDataPacket[]>('SELECT setting_value FROM settings WHERE company_id=? AND setting_key=? LOCK IN SHARE MODE',[input.companyId,'inventory.cost_method'])
    const method=String(policies[0]?.setting_value??'weighted_average')
    if(!['weighted_average','fifo'].includes(method))throw new ValidationError('Metode biaya persediaan tidak didukung')
    if (await this.repository.movementByPostingKey(connection, input.companyId, input.postingKey)) {
      throw new ConflictError('Pergerakan stok untuk baris transaksi ini sudah pernah dibuat')
    }
    await this.validation.ensureActiveReference(connection, {
      table: 'warehouses',
      id: input.warehouseId,
      companyId: input.companyId,
      label: 'Gudang',
    })
    const item = await this.repository.item(connection, input.companyId, input.itemId)
    if (!item) throw new NotFoundError('Barang tidak ditemukan atau tidak aktif')
    if (item.item_type !== 'inventory') {
      throw new ValidationError('Hanya barang bertipe inventory yang dapat mengubah stok')
    }

    const quantity = normalizeDecimal(input.quantity, 4)
    if (compareDecimal(quantity, '0', 4) <= 0) {
      throw new ValidationError('Kuantitas pergerakan stok harus lebih dari nol')
    }
    const balance = await this.repository.lockBalance(
      connection,
      input.companyId,
      input.itemId,
      input.warehouseId,
    )
    if (!balance) throw new ConflictError('Saldo persediaan tidak dapat dikunci')
    if(input.isReversal){
      const original=await this.repository.movement(connection,input.companyId,Number(input.reversalMovementId))
      if(original&&String(original.cost_method??'weighted_average')!==method)throw new ConflictError('Metode biaya telah berubah; reversal transaksi metode lama memerlukan rekonsiliasi khusus')
    }
    if (method === 'weighted_average') {
      const [latest] = await connection.execute<RowDataPacket[]>('SELECT movement_date FROM inventory_movements WHERE company_id=? AND item_id=? AND warehouse_id=? ORDER BY movement_date DESC,id DESC LIMIT 1 FOR UPDATE', [input.companyId,input.itemId,input.warehouseId])
      const date = latest[0]?.movement_date
      const latestDate = date instanceof Date ? `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}` : String(date ?? '').slice(0,10)
      if (latestDate && input.movementDate.slice(0,10) < latestDate) throw new ConflictError('Tanggal mutasi mendahului mutasi terakhir barang/gudang. Gunakan tanggal berjalan atau proses koreksi terkontrol.')
    }
    if(method==='fifo')return new FifoCostingService().apply(connection,input,balance)

    const oldQuantity = normalizeDecimal(balance.quantity, 4)
    const oldAverageCost = normalizeDecimal(balance.average_cost, 6)
    const oldValue = normalizeDecimal(balance.total_value)
    let newQuantity: string
    let newAverageCost: string
    let newValue: string
    let unitCost: string
    let movementValue: string

    if (input.direction === 'in') {
      unitCost = normalizeDecimal(input.unitCost ?? '0', 6)
      if (compareDecimal(unitCost, '0', 6) < 0) {
        throw new ValidationError('Biaya masuk persediaan tidak boleh negatif')
      }
      movementValue = input.totalCostOverride??multiplyDecimal(quantity, 4, unitCost, 6, 2)
      newQuantity = addDecimal([oldQuantity, quantity], 4)
      newValue = addDecimal([oldValue, movementValue])
      newAverageCost =
        compareDecimal(newQuantity, '0', 4) === 0
          ? '0.000000'
          : divideDecimal(newValue, 2, newQuantity, 4, 6)
    } else {
      newQuantity = subtractDecimal(oldQuantity, quantity, 4)
      if (
        compareDecimal(newQuantity, '0', 4) < 0 &&
        !(await this.repository.negativeStockAllowed(connection, input.companyId))
      ) {
        throw new ConflictError(
          `Stok ${String(item.sku)} di gudang tidak mencukupi (tersedia ${oldQuantity})`,
        )
      }
      unitCost = oldAverageCost
      // The final issue consumes the exact remaining carrying value, including rounding residue.
      movementValue = compareDecimal(newQuantity, '0', 4) === 0
        ? oldValue
        : multiplyDecimal(quantity, 4, unitCost, 6, 2)
      newAverageCost = compareDecimal(newQuantity, '0', 4) === 0 ? '0.000000' : oldAverageCost
      newValue =
        compareDecimal(newQuantity, '0', 4) === 0
          ? '0.00'
          : compareDecimal(newQuantity, '0', 4) < 0
            ? multiplyDecimal(newQuantity, 4, unitCost, 6, 2)
            : subtractDecimal(oldValue, movementValue)
    }

    if (input.isReversal && input.direction === 'out') {
      movementValue = normalizeDecimal(input.totalCostOverride ?? movementValue)
      newValue = subtractDecimal(oldValue, movementValue)
      if (compareDecimal(newQuantity, '0', 4) < 0 || compareDecimal(newValue, '0') < 0 ||
          (compareDecimal(newQuantity, '0', 4) === 0 && compareDecimal(newValue, '0') !== 0)) {
        throw new ConflictError('Reversal membuat saldo stok tidak valid. Balik transaksi pemakaian terkait terlebih dahulu.')
      }
      unitCost = normalizeDecimal(input.unitCost ?? oldAverageCost, 6)
      newAverageCost = compareDecimal(newQuantity, '0', 4) === 0 ? '0.000000' : divideDecimal(newValue, 2, newQuantity, 4, 6)
    }

    await this.repository.updateBalance(
      connection,
      Number(balance.id),
      newQuantity,
      newAverageCost,
      newValue,
    )
    const movementId = await this.repository.insertMovement(connection, {
      companyId: input.companyId,
      itemId: input.itemId,
      warehouseId: input.warehouseId,
      transactionType: input.transactionType,
      transactionId: input.transactionId,
      sourceLineId: input.sourceLineId,
      transactionNumber: input.transactionNumber,
      movementDate: input.movementDate,
      quantityIn: input.direction === 'in' ? quantity : '0.0000',
      quantityOut: input.direction === 'out' ? quantity : '0.0000',
      unitCost,
      totalCost: movementValue,
      runningQuantity: newQuantity,
      runningValue: newValue,
      reference: input.reference,
      journalId: input.journalId,
      postingKey: input.postingKey,
      userId: input.userId,
      isReversal: input.isReversal,
      reversalMovementId: input.reversalMovementId,
    })
    await this.repository.refreshItemAverageCost(connection, input.companyId, input.itemId)
    return { movementId, unitCost, totalCost: movementValue, quantity: newQuantity, value: newValue, costSlices: undefined as CostSlice[] | undefined }
  }

  async reverseMovement(
    connection: QueryExecutor,
    input: {
      companyId: number
      movementId: number
      movementDate: string
      transactionType: string
      transactionId: number
      transactionNumber: string
      userId: number
      reference?: string | null
    },
  ) {
    const original = await this.repository.movement(connection, input.companyId, input.movementId)
    if (!original) throw new NotFoundError('Pergerakan stok asal tidak ditemukan')
    if (original.reversal_movement_id) throw new ConflictError('Pergerakan stok sudah direversal')
    const originalIn = compareDecimal(String(original.quantity_in), '0', 4) > 0
    const result = await this.applyMovement(connection, {
      companyId: input.companyId,
      itemId: Number(original.item_id),
      warehouseId: Number(original.warehouse_id),
      direction: originalIn ? 'out' : 'in',
      quantity: originalIn ? String(original.quantity_in) : String(original.quantity_out),
      unitCost: String(original.unit_cost),
      totalCostOverride: String(original.total_cost),
      transactionType: input.transactionType,
      transactionId: input.transactionId,
      sourceLineId: Number(original.source_line_id ?? original.id),
      transactionNumber: input.transactionNumber,
      movementDate: input.movementDate,
      reference: input.reference,
      postingKey: `reversal:${original.id}`,
      userId: input.userId,
      isReversal: true,
      reversalMovementId: Number(original.id),
    })
    await connection.execute(
      'UPDATE inventory_movements SET reversal_movement_id = ? WHERE id = ?',
      [result.movementId, original.id],
    )
    return result
  }
}
