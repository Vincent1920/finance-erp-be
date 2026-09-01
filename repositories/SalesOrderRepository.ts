import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'

import { db } from '../config/database'
import type { DatabaseValue, QueryExecutor } from '../types/database'

export interface SalesOrderLineWrite {
  lineNumber: number
  itemId: number
  description: string | null
  quantity: string
  unitId: number
  unitPrice: string
  discountPercent: string
  discountAmount: string
  taxCodeId: number | null
  taxRate: string
  taxAmount: string
  subtotal: string
  baseSubtotal: string
}

export interface SalesOrderWrite {
  companyId: number
  orderNumber: string
  orderDate: string
  customerId: number
  warehouseId: number
  salesPersonId: number | null
  paymentTermDays: number
  expectedDate: string | null
  reference: string | null
  currency: string
  exchangeRate: string
  notes: string | null
  subtotal: string
  discount: string
  tax: string
  grandTotal: string
  baseGrandTotal: string
  userId: number
  lines: SalesOrderLineWrite[]
}

export class SalesOrderRepository {
  async list(
    companyId: number,
    query: {
      page: number
      limit: number
      search?: string
      status?: string
      customer_id?: number
      date_from?: string
      date_to?: string
      sort: string
      order: 'asc' | 'desc'
    },
  ) {
    const conditions = ['so.company_id = ?', 'so.deleted_at IS NULL']
    const values: DatabaseValue[] = [companyId]
    if (query.search) {
      conditions.push('(so.order_number LIKE ? OR so.reference LIKE ? OR c.name LIKE ?)')
      const search = `%${query.search}%`
      values.push(search, search, search)
    }
    if (query.status) {
      conditions.push('so.status = ?')
      values.push(query.status)
    }
    if (query.customer_id) {
      conditions.push('so.customer_id = ?')
      values.push(query.customer_id)
    }
    if (query.date_from) {
      conditions.push('so.order_date >= ?')
      values.push(query.date_from)
    }
    if (query.date_to) {
      conditions.push('so.order_date <= ?')
      values.push(query.date_to)
    }
    const where = conditions.join(' AND ')
    const sortColumns: Record<string, string> = {
      order_date: 'so.order_date',
      order_number: 'so.order_number',
      grand_total: 'so.grand_total',
      status: 'so.status',
      created_at: 'so.created_at',
    }
    const offset = (query.page - 1) * query.limit
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT so.id, so.order_number, so.order_date, so.expected_date, so.reference,
              so.currency, so.grand_total, so.status, so.fulfillment_status, so.version,
              so.created_at, c.id AS customer_id, c.code AS customer_code,
              c.name AS customer_name, w.code AS warehouse_code, w.name AS warehouse_name,
              COUNT(sol.id) AS line_count
       FROM sales_orders so
       INNER JOIN customers c ON c.id = so.customer_id
       INNER JOIN warehouses w ON w.id = so.warehouse_id
       LEFT JOIN sales_order_lines sol ON sol.sales_order_id = so.id
       WHERE ${where}
       GROUP BY so.id
       ORDER BY ${sortColumns[query.sort] ?? 'so.order_date'} ${query.order.toUpperCase()}, so.id DESC
       LIMIT ? OFFSET ?`,
      [...values, query.limit, offset],
    )
    const [counts] = await db.execute<(RowDataPacket & { total: number })[]>(
      `SELECT COUNT(*) AS total
       FROM sales_orders so INNER JOIN customers c ON c.id = so.customer_id
       WHERE ${where}`,
      values,
    )
    return { rows, total: Number(counts[0]?.total ?? 0), page: query.page, limit: query.limit }
  }

  async find(id: number, companyId: number, connection: QueryExecutor = db, lock = false) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT so.*, c.code AS customer_code, c.name AS customer_name,
              w.code AS warehouse_code, w.name AS warehouse_name,
              creator.name AS created_by_name
       FROM sales_orders so
       INNER JOIN customers c ON c.id = so.customer_id
       INNER JOIN warehouses w ON w.id = so.warehouse_id
       INNER JOIN users creator ON creator.id = so.created_by
       WHERE so.id = ? AND so.company_id = ? AND so.deleted_at IS NULL
       LIMIT 1 ${lock ? 'FOR UPDATE' : ''}`,
      [id, companyId],
    )
    return rows[0] ?? null
  }

  async lines(id: number, connection: QueryExecutor = db) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT sol.*, i.sku AS item_code, i.name AS item_name, i.item_type,
              u.code AS unit_code, u.name AS unit_name, tc.code AS tax_code
       FROM sales_order_lines sol
       INNER JOIN items i ON i.id = sol.item_id
       INNER JOIN units u ON u.id = sol.unit_id
       LEFT JOIN tax_codes tc ON tc.id = sol.tax_code_id
       WHERE sol.sales_order_id = ? ORDER BY sol.line_number`,
      [id],
    )
    return rows
  }

  async detail(id: number, companyId: number) {
    const header = await this.find(id, companyId)
    if (!header) return null
    return { ...header, lines: await this.lines(id) }
  }

  async references(connection: QueryExecutor, companyId: number, input: SalesOrderWrite) {
    const [customers] = await connection.execute<RowDataPacket[]>(
      `SELECT id, currency FROM customers
       WHERE id = ? AND company_id = ? AND is_active = TRUE AND deleted_at IS NULL`,
      [input.customerId, companyId],
    )
    const [warehouses] = await connection.execute<RowDataPacket[]>(
      'SELECT id FROM warehouses WHERE id = ? AND company_id = ? AND is_active = TRUE',
      [input.warehouseId, companyId],
    )
    const itemIds = [...new Set(input.lines.map((line) => line.itemId))]
    const marks = itemIds.map(() => '?').join(',')
    const [items] = await connection.execute<RowDataPacket[]>(
      `SELECT id, unit_id FROM items
       WHERE company_id = ? AND is_active = TRUE AND deleted_at IS NULL AND id IN (${marks})`,
      [companyId, ...itemIds],
    )
    const taxIds = [...new Set(input.lines.map((line) => line.taxCodeId).filter(Boolean))]
    let taxes: RowDataPacket[] = []
    if (taxIds.length) {
      const taxMarks = taxIds.map(() => '?').join(',')
      ;[taxes] = await connection.execute<RowDataPacket[]>(
        `SELECT id, rate FROM tax_codes
         WHERE company_id = ? AND is_active = TRUE AND id IN (${taxMarks})`,
        [companyId, ...taxIds],
      )
    }
    return { customer: customers[0] ?? null, warehouse: warehouses[0] ?? null, items, taxes }
  }

  async insert(connection: QueryExecutor, input: SalesOrderWrite) {
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO sales_orders(
         company_id, order_number, order_date, customer_id, warehouse_id, sales_person_id,
         payment_term_days, expected_date, reference, currency, exchange_rate,
         subtotal, discount, tax, grand_total, base_grand_total, notes, status, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
      [
        input.companyId,
        input.orderNumber,
        input.orderDate,
        input.customerId,
        input.warehouseId,
        input.salesPersonId,
        input.paymentTermDays,
        input.expectedDate,
        input.reference,
        input.currency,
        input.exchangeRate,
        input.subtotal,
        input.discount,
        input.tax,
        input.grandTotal,
        input.baseGrandTotal,
        input.notes,
        input.userId,
      ],
    )
    await this.replaceLines(connection, result.insertId, input.lines)
    return result.insertId
  }

  async update(connection: QueryExecutor, id: number, version: number, input: SalesOrderWrite) {
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE sales_orders SET order_date = ?, customer_id = ?, warehouse_id = ?,
         sales_person_id = ?, payment_term_days = ?, expected_date = ?, reference = ?,
         currency = ?, exchange_rate = ?, subtotal = ?, discount = ?, tax = ?,
         grand_total = ?, base_grand_total = ?, notes = ?, updated_by = ?, version = version + 1
       WHERE id = ? AND company_id = ? AND status = 'draft' AND version = ?`,
      [
        input.orderDate,
        input.customerId,
        input.warehouseId,
        input.salesPersonId,
        input.paymentTermDays,
        input.expectedDate,
        input.reference,
        input.currency,
        input.exchangeRate,
        input.subtotal,
        input.discount,
        input.tax,
        input.grandTotal,
        input.baseGrandTotal,
        input.notes,
        input.userId,
        id,
        input.companyId,
        version,
      ],
    )
    if (!result.affectedRows) return false
    await this.replaceLines(connection, id, input.lines)
    return true
  }

  async replaceLines(connection: QueryExecutor, id: number, lines: SalesOrderLineWrite[]) {
    await connection.execute('DELETE FROM sales_order_lines WHERE sales_order_id = ?', [id])
    for (const line of lines) {
      await connection.execute(
        `INSERT INTO sales_order_lines(
           sales_order_id, line_number, item_id, description, quantity, unit_id,
           unit_price, discount_percent, discount_amount, tax_code_id, tax_rate,
           tax_amount, subtotal, base_subtotal
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          line.lineNumber,
          line.itemId,
          line.description,
          line.quantity,
          line.unitId,
          line.unitPrice,
          line.discountPercent,
          line.discountAmount,
          line.taxCodeId,
          line.taxRate,
          line.taxAmount,
          line.subtotal,
          line.baseSubtotal,
        ],
      )
    }
  }

  async transition(
    connection: QueryExecutor,
    id: number,
    companyId: number,
    from: string[],
    fields: string,
    values: DatabaseValue[],
  ) {
    const marks = from.map(() => '?').join(',')
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE sales_orders SET ${fields}, version = version + 1
       WHERE id = ? AND company_id = ? AND status IN (${marks})`,
      [...values, id, companyId, ...from],
    )
    return result.affectedRows > 0
  }

  async linkInvoice(
    connection: QueryExecutor,
    orderId: number,
    invoiceId: number,
    lines: Array<{ orderLineId: number; quantity: string; invoiceLineNumber: number }>,
  ) {
    await connection.execute('UPDATE sales_invoices SET sales_order_id = ? WHERE id = ?', [
      orderId,
      invoiceId,
    ])
    for (const line of lines) {
      await connection.execute(
        `UPDATE sales_invoice_lines SET sales_order_line_id = ?
         WHERE sales_invoice_id = ? AND line_number = ?`,
        [line.orderLineId, invoiceId, line.invoiceLineNumber],
      )
      await connection.execute(
        `UPDATE sales_order_lines SET invoiced_quantity = invoiced_quantity + ?
         WHERE id = ? AND sales_order_id = ?`,
        [line.quantity, line.orderLineId, orderId],
      )
    }
    const [remaining] = await connection.execute<(RowDataPacket & { remaining: number })[]>(
      `SELECT COUNT(*) AS remaining FROM sales_order_lines
       WHERE sales_order_id = ? AND invoiced_quantity < quantity`,
      [orderId],
    )
    const status = Number(remaining[0]?.remaining ?? 0) === 0 ? 'invoiced' : 'partially_invoiced'
    await connection.execute(
      'UPDATE sales_orders SET status = ?, version = version + 1 WHERE id = ?',
      [status, orderId],
    )
    return status
  }
}
