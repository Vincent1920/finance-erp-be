import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { db } from '../config/database'
import type { DatabaseValue, QueryExecutor } from '../types/database'

export interface PurchaseOrderLineWrite {
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
export interface PurchaseOrderWrite {
  companyId: number
  orderNumber: string
  orderDate: string
  supplierId: number
  warehouseId: number
  buyerId: number | null
  paymentTermDays: number
  expectedDate: string | null
  supplierReference: string | null
  currency: string
  exchangeRate: string
  subtotal: string
  discount: string
  tax: string
  grandTotal: string
  baseGrandTotal: string
  notes: string | null
  userId: number
  lines: PurchaseOrderLineWrite[]
}

export class PurchaseOrderRepository {
  async list(
    companyId: number,
    q: {
      page: number
      limit: number
      search?: string
      status?: string
      supplier_id?: number
      date_from?: string
      date_to?: string
      sort: string
      order: 'asc' | 'desc'
    },
  ) {
    const conditions = ['po.company_id=?', 'po.deleted_at IS NULL'],
      values: DatabaseValue[] = [companyId]
    if (q.search) {
      conditions.push('(po.order_number LIKE ? OR po.supplier_reference LIKE ? OR s.name LIKE ?)')
      const v = `%${q.search}%`
      values.push(v, v, v)
    }
    if (q.status) {
      conditions.push('po.status=?')
      values.push(q.status)
    }
    if (q.supplier_id) {
      conditions.push('po.supplier_id=?')
      values.push(q.supplier_id)
    }
    if (q.date_from) {
      conditions.push('po.order_date>=?')
      values.push(q.date_from)
    }
    if (q.date_to) {
      conditions.push('po.order_date<=?')
      values.push(q.date_to)
    }
    const where = conditions.join(' AND '),
      sorts: Record<string, string> = {
        order_date: 'po.order_date',
        order_number: 'po.order_number',
        grand_total: 'po.grand_total',
        status: 'po.status',
        created_at: 'po.created_at',
      },
      offset = (q.page - 1) * q.limit
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT po.id,po.order_number,po.order_date,po.expected_date,po.supplier_reference,po.currency,po.grand_total,po.status,po.receipt_status,po.billing_status,po.version,po.created_at,s.id supplier_id,s.code supplier_code,s.name supplier_name,w.code warehouse_code,w.name warehouse_name,COUNT(pol.id) line_count FROM purchase_orders po INNER JOIN suppliers s ON s.id=po.supplier_id INNER JOIN warehouses w ON w.id=po.warehouse_id LEFT JOIN purchase_order_lines pol ON pol.purchase_order_id=po.id WHERE ${where} GROUP BY po.id ORDER BY ${sorts[q.sort] ?? 'po.order_date'} ${q.order.toUpperCase()},po.id DESC LIMIT ? OFFSET ?`,
      [...values, q.limit, offset],
    )
    const [count] = await db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) total FROM purchase_orders po INNER JOIN suppliers s ON s.id=po.supplier_id WHERE ${where}`,
      values,
    )
    return { rows, total: Number(count[0]?.total ?? 0), page: q.page, limit: q.limit }
  }
  async find(connection: QueryExecutor, id: number, companyId: number, lock = false) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT po.*,s.code supplier_code,s.name supplier_name,w.code warehouse_code,w.name warehouse_name,u.name created_by_name FROM purchase_orders po INNER JOIN suppliers s ON s.id=po.supplier_id INNER JOIN warehouses w ON w.id=po.warehouse_id INNER JOIN users u ON u.id=po.created_by WHERE po.id=? AND po.company_id=? AND po.deleted_at IS NULL LIMIT 1 ${lock ? 'FOR UPDATE' : ''}`,
      [id, companyId],
    )
    return rows[0] ?? null
  }
  async lines(id: number, connection: QueryExecutor = db) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT pol.*,i.sku item_code,i.name item_name,i.item_type,u.code unit_code,u.name unit_name,tc.code tax_code FROM purchase_order_lines pol INNER JOIN items i ON i.id=pol.item_id INNER JOIN units u ON u.id=pol.unit_id LEFT JOIN tax_codes tc ON tc.id=pol.tax_code_id WHERE pol.purchase_order_id=? ORDER BY pol.line_number`,
      [id],
    )
    return rows
  }
  async detail(id: number, companyId: number) {
    const h = await this.find(db, id, companyId)
    return h ? { ...h, lines: await this.lines(id) } : null
  }
  async references(connection: QueryExecutor, companyId: number, input: PurchaseOrderWrite) {
    const [suppliers] = await connection.execute<RowDataPacket[]>(
      'SELECT id,currency FROM suppliers WHERE id=? AND company_id=? AND is_active=TRUE AND deleted_at IS NULL',
      [input.supplierId, companyId],
    )
    const [warehouses] = await connection.execute<RowDataPacket[]>(
      'SELECT id FROM warehouses WHERE id=? AND company_id=? AND is_active=TRUE',
      [input.warehouseId, companyId],
    )
    const itemIds = [...new Set(input.lines.map((x) => x.itemId))],
      marks = itemIds.map(() => '?').join(','),
      [items] = await connection.execute<RowDataPacket[]>(
        `SELECT id,unit_id FROM items WHERE company_id=? AND is_active=TRUE AND deleted_at IS NULL AND id IN (${marks})`,
        [companyId, ...itemIds],
      )
    const taxIds = [
      ...new Set(input.lines.map((x) => x.taxCodeId).filter((x): x is number => Boolean(x))),
    ]
    let taxes: RowDataPacket[] = []
    if (taxIds.length) {
      const m = taxIds.map(() => '?').join(',')
      ;[taxes] = await connection.execute<RowDataPacket[]>(
        `SELECT id,rate FROM tax_codes WHERE company_id=? AND is_active=TRUE AND id IN (${m})`,
        [companyId, ...taxIds],
      )
    }
    return { supplier: suppliers[0] ?? null, warehouse: warehouses[0] ?? null, items, taxes }
  }
  async insert(connection: QueryExecutor, h: PurchaseOrderWrite) {
    const [r] = await connection.execute<ResultSetHeader>(
      `INSERT INTO purchase_orders(company_id,order_number,order_date,supplier_id,warehouse_id,buyer_id,payment_term_days,expected_date,supplier_reference,currency,exchange_rate,subtotal,discount,tax,grand_total,base_grand_total,notes,status,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?)`,
      [
        h.companyId,
        h.orderNumber,
        h.orderDate,
        h.supplierId,
        h.warehouseId,
        h.buyerId,
        h.paymentTermDays,
        h.expectedDate,
        h.supplierReference,
        h.currency,
        h.exchangeRate,
        h.subtotal,
        h.discount,
        h.tax,
        h.grandTotal,
        h.baseGrandTotal,
        h.notes,
        h.userId,
      ],
    )
    await this.replaceLines(connection, r.insertId, h.lines)
    return r.insertId
  }
  async update(connection: QueryExecutor, id: number, version: number, h: PurchaseOrderWrite) {
    const [r] = await connection.execute<ResultSetHeader>(
      `UPDATE purchase_orders SET order_date=?,supplier_id=?,warehouse_id=?,buyer_id=?,payment_term_days=?,expected_date=?,supplier_reference=?,currency=?,exchange_rate=?,subtotal=?,discount=?,tax=?,grand_total=?,base_grand_total=?,notes=?,updated_by=?,version=version+1 WHERE id=? AND company_id=? AND status='draft' AND version=?`,
      [
        h.orderDate,
        h.supplierId,
        h.warehouseId,
        h.buyerId,
        h.paymentTermDays,
        h.expectedDate,
        h.supplierReference,
        h.currency,
        h.exchangeRate,
        h.subtotal,
        h.discount,
        h.tax,
        h.grandTotal,
        h.baseGrandTotal,
        h.notes,
        h.userId,
        id,
        h.companyId,
        version,
      ],
    )
    if (!r.affectedRows) return false
    await this.replaceLines(connection, id, h.lines)
    return true
  }
  async replaceLines(connection: QueryExecutor, id: number, lines: PurchaseOrderLineWrite[]) {
    await connection.execute('DELETE FROM purchase_order_lines WHERE purchase_order_id=?', [id])
    for (const l of lines)
      await connection.execute(
        `INSERT INTO purchase_order_lines(purchase_order_id,line_number,item_id,description,quantity,unit_id,unit_price,discount_percent,discount_amount,tax_code_id,tax_rate,tax_amount,subtotal,base_subtotal) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          l.lineNumber,
          l.itemId,
          l.description,
          l.quantity,
          l.unitId,
          l.unitPrice,
          l.discountPercent,
          l.discountAmount,
          l.taxCodeId,
          l.taxRate,
          l.taxAmount,
          l.subtotal,
          l.baseSubtotal,
        ],
      )
  }
  async transition(
    connection: QueryExecutor,
    id: number,
    companyId: number,
    from: string[],
    fields: string,
    values: DatabaseValue[],
  ) {
    const marks = from.map(() => '?').join(','),
      [r] = await connection.execute<ResultSetHeader>(
        `UPDATE purchase_orders SET ${fields},version=version+1 WHERE id=? AND company_id=? AND status IN (${marks})`,
        [...values, id, companyId, ...from],
      )
    return r.affectedRows > 0
  }

  async activeReceiptCount(connection: QueryExecutor, orderId: number) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT COUNT(*) total FROM goods_receipts
       WHERE purchase_order_id=? AND status IN('draft','posted')`,
      [orderId],
    )
    return Number(rows[0]?.total ?? 0)
  }
}
