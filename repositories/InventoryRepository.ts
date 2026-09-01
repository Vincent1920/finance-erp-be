import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'

import { db } from '../config/database'
import type { QueryExecutor } from '../types/database'
import { pagination } from '../utils/pagination'

export interface InventoryBalanceRow extends RowDataPacket {
  id: number
  company_id: number
  item_id: number
  warehouse_id: number
  quantity: string | number
  average_cost: string | number
  total_value: string | number
  version: number
}

export interface InventoryMovementWrite {
  companyId: number
  itemId: number
  warehouseId: number
  transactionType: string
  transactionId: number
  sourceLineId?: number | null
  transactionNumber: string
  movementDate: string
  quantityIn: string
  quantityOut: string
  unitCost: string
  totalCost: string
  runningQuantity: string
  runningValue: string
  reference?: string | null
  journalId?: number | null
  postingKey: string
  userId: number
  isReversal?: boolean
  reversalMovementId?: number | null
}

export class InventoryRepository {
  async item(connection: QueryExecutor, companyId: number, itemId: number) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT i.*, u.code AS unit_code
       FROM items i
       INNER JOIN units u ON u.id = i.unit_id AND u.company_id = i.company_id
       WHERE i.id = ? AND i.company_id = ? AND i.is_active = TRUE AND i.deleted_at IS NULL
       LIMIT 1`,
      [itemId, companyId],
    )
    return rows[0] ?? null
  }

  async movementByPostingKey(connection: QueryExecutor, companyId: number, postingKey: string) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT * FROM inventory_movements
       WHERE company_id = ? AND posting_key = ?
       LIMIT 1
       FOR UPDATE`,
      [companyId, postingKey],
    )
    return rows[0] ?? null
  }

  async movement(connection: QueryExecutor, companyId: number, movementId: number) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT * FROM inventory_movements
       WHERE id = ? AND company_id = ?
       LIMIT 1
       FOR UPDATE`,
      [movementId, companyId],
    )
    return rows[0] ?? null
  }

  async overview(
    companyId: number,
    query: {
      page?: string
      limit?: string
      search?: string
      warehouseId?: number
      itemId?: number
      status?: string
    },
  ) {
    const { page, limit, offset } = pagination(query.page, query.limit)
    const conditions = ['ib.company_id = ?', 'i.deleted_at IS NULL']
    const values: Array<string | number> = [companyId]
    if (query.search) {
      conditions.push('(i.sku LIKE ? OR i.name LIKE ? OR w.code LIKE ? OR w.name LIKE ?)')
      const search = `%${query.search}%`
      values.push(search, search, search, search)
    }
    if (query.warehouseId) {
      conditions.push('ib.warehouse_id = ?')
      values.push(query.warehouseId)
    }
    if (query.itemId) {
      conditions.push('ib.item_id = ?')
      values.push(query.itemId)
    }
    if (query.status === 'out_of_stock') conditions.push('ib.quantity <= 0')
    if (query.status === 'low_stock') {
      conditions.push('ib.quantity > 0 AND ib.quantity <= i.minimum_stock')
    }
    if (query.status === 'available') conditions.push('ib.quantity > i.minimum_stock')
    const where = conditions.join(' AND ')
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT
         ib.id,
         ib.item_id,
         i.sku,
         i.name AS item_name,
         i.item_type,
         i.minimum_stock,
         u.code AS unit_code,
         u.symbol AS unit_symbol,
         ib.warehouse_id,
         w.code AS warehouse_code,
         w.name AS warehouse_name,
         ib.quantity,
         ib.average_cost,
         ib.total_value AS inventory_value,
         CASE
           WHEN ib.quantity <= 0 THEN 'out_of_stock'
           WHEN ib.quantity <= i.minimum_stock THEN 'low_stock'
           ELSE 'available'
         END AS stock_status
       FROM inventory_balances ib
       INNER JOIN items i ON i.id = ib.item_id AND i.company_id = ib.company_id
       INNER JOIN warehouses w ON w.id = ib.warehouse_id AND w.company_id = ib.company_id
       INNER JOIN units u ON u.id = i.unit_id AND u.company_id = ib.company_id
       WHERE ${where}
       ORDER BY i.sku, w.code
       LIMIT ? OFFSET ?`,
      [...values, limit, offset],
    )
    const [counts] = await db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total
       FROM inventory_balances ib
       INNER JOIN items i ON i.id = ib.item_id AND i.company_id = ib.company_id
       INNER JOIN warehouses w ON w.id = ib.warehouse_id AND w.company_id = ib.company_id
       WHERE ${where}`,
      values,
    )
    return { rows, page, limit, total: Number(counts[0]?.total ?? 0) }
  }

  async card(
    companyId: number,
    query: {
      itemId: number
      warehouseId?: number
      dateFrom: string
      dateTo: string
      page?: string
      limit?: string
    },
  ) {
    const { page, limit, offset } = pagination(query.page, query.limit)
    const warehouseCondition = query.warehouseId ? 'AND im.warehouse_id = ?' : ''
    const baseValues: Array<string | number> = [companyId, query.itemId]
    if (query.warehouseId) baseValues.push(query.warehouseId)
    const [openingRows] = await db.execute<RowDataPacket[]>(
      `SELECT
         COALESCE(SUM(im.quantity_in - im.quantity_out), 0) AS opening_quantity,
         COALESCE(SUM(CASE WHEN im.quantity_in > 0 THEN im.total_cost ELSE -im.total_cost END), 0)
           AS opening_value
       FROM inventory_movements im
       WHERE im.company_id = ? AND im.item_id = ? ${warehouseCondition}
         AND im.movement_date < ?`,
      [...baseValues, query.dateFrom],
    )
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT
         im.*,
         i.sku,
         i.name AS item_name,
         w.code AS warehouse_code,
         w.name AS warehouse_name,
         u.symbol AS unit_symbol,
         COUNT(*) OVER () AS total_rows
       FROM inventory_movements im
       INNER JOIN items i ON i.id = im.item_id AND i.company_id = im.company_id
       INNER JOIN units u ON u.id = i.unit_id AND u.company_id = im.company_id
       INNER JOIN warehouses w ON w.id = im.warehouse_id AND w.company_id = im.company_id
       WHERE im.company_id = ? AND im.item_id = ? ${warehouseCondition}
         AND im.movement_date BETWEEN ? AND ?
       ORDER BY im.movement_date, im.id
       LIMIT ? OFFSET ?`,
      [...baseValues, query.dateFrom, query.dateTo, limit, offset],
    )
    return {
      rows,
      opening: openingRows[0] ?? { opening_quantity: '0', opening_value: '0' },
      page,
      limit,
      total: Number(rows[0]?.total_rows ?? 0),
    }
  }

  async lockBalance(
    connection: QueryExecutor,
    companyId: number,
    itemId: number,
    warehouseId: number,
  ) {
    await connection.execute<ResultSetHeader>(
      `INSERT INTO inventory_balances (
         company_id, item_id, warehouse_id, quantity, average_cost, total_value, version
       ) VALUES (?, ?, ?, 0, 0, 0, 0)
       ON DUPLICATE KEY UPDATE id = id`,
      [companyId, itemId, warehouseId],
    )
    const [rows] = await connection.execute<InventoryBalanceRow[]>(
      `SELECT *
       FROM inventory_balances
       WHERE company_id = ? AND item_id = ? AND warehouse_id = ?
       FOR UPDATE`,
      [companyId, itemId, warehouseId],
    )
    return rows[0]
  }

  async updateBalance(
    connection: QueryExecutor,
    id: number,
    quantity: string,
    averageCost: string,
    totalValue: string,
  ) {
    await connection.execute(
      `UPDATE inventory_balances
       SET quantity = ?, average_cost = ?, total_value = ?, version = version + 1
       WHERE id = ?`,
      [quantity, averageCost, totalValue, id],
    )
  }

  async refreshItemAverageCost(connection: QueryExecutor, companyId: number, itemId: number) {
    await connection.execute(
      `UPDATE items i
       SET i.average_cost = COALESCE((
         SELECT CASE WHEN SUM(ib.quantity) = 0 THEN 0 ELSE SUM(ib.total_value) / SUM(ib.quantity) END
         FROM inventory_balances ib
         WHERE ib.company_id = ? AND ib.item_id = ?
       ), 0)
       WHERE i.id = ? AND i.company_id = ?`,
      [companyId, itemId, itemId, companyId],
    )
  }

  async insertMovement(connection: QueryExecutor, input: InventoryMovementWrite) {
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO inventory_movements (
         company_id, item_id, warehouse_id, transaction_type, transaction_id,
         source_line_id, transaction_number, movement_date, quantity_in, quantity_out,
         unit_cost, total_cost, running_quantity, running_value, reference, journal_id,
         posting_key, is_reversal, reversal_movement_id, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.companyId,
        input.itemId,
        input.warehouseId,
        input.transactionType,
        input.transactionId,
        input.sourceLineId ?? null,
        input.transactionNumber,
        input.movementDate,
        input.quantityIn,
        input.quantityOut,
        input.unitCost,
        input.totalCost,
        input.runningQuantity,
        input.runningValue,
        input.reference ?? null,
        input.journalId ?? null,
        input.postingKey,
        input.isReversal ?? false,
        input.reversalMovementId ?? null,
        input.userId,
      ],
    )
    return result.insertId
  }

  async negativeStockAllowed(connection: QueryExecutor, companyId: number) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT setting_value FROM settings
       WHERE company_id = ? AND setting_key = 'allow_negative_stock'
       LIMIT 1`,
      [companyId],
    )
    const value = String(rows[0]?.setting_value ?? 'false')
      .replaceAll('"', '')
      .toLowerCase()
    return value === 'true' || value === '1'
  }
}
