import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { db } from '../config/database'
import type { DatabaseValue, QueryExecutor } from '../types/database'
export class GoodsReceiptRepository {
  async list(c: number, q: { page: number; limit: number; search?: string; status?: string }) {
    const where = ['gr.company_id=?'],
      v: DatabaseValue[] = [c]
    if (q.search) {
      where.push(
        '(gr.receipt_number LIKE ? OR gr.supplier_delivery_number LIKE ? OR s.name LIKE ?)',
      )
      const s = `%${q.search}%`
      v.push(s, s, s)
    }
    if (q.status) {
      where.push('gr.status=?')
      v.push(q.status)
    }
    const w = where.join(' AND '),
      offset = (q.page - 1) * q.limit,
      [rows] = await db.query<RowDataPacket[]>(
        `SELECT gr.*,po.order_number,s.code supplier_code,s.name supplier_name,w.code warehouse_code,COUNT(grl.id) line_count FROM goods_receipts gr INNER JOIN purchase_orders po ON po.id=gr.purchase_order_id INNER JOIN suppliers s ON s.id=gr.supplier_id INNER JOIN warehouses w ON w.id=gr.warehouse_id LEFT JOIN goods_receipt_lines grl ON grl.goods_receipt_id=gr.id WHERE ${w} GROUP BY gr.id ORDER BY gr.receipt_date DESC,gr.id DESC LIMIT ? OFFSET ?`,
        [...v, q.limit, offset],
      ),
      [count] = await db.execute<RowDataPacket[]>(
        `SELECT COUNT(*) total FROM goods_receipts gr INNER JOIN suppliers s ON s.id=gr.supplier_id WHERE ${w}`,
        v,
      )
    return { rows, total: Number(count[0]?.total ?? 0), page: q.page, limit: q.limit }
  }
  async find(q: QueryExecutor, id: number, c: number, lock = false) {
    const [r] = await q.execute<RowDataPacket[]>(
      `SELECT gr.*,po.order_number,s.code supplier_code,s.name supplier_name,w.code warehouse_code,w.name warehouse_name FROM goods_receipts gr INNER JOIN purchase_orders po ON po.id=gr.purchase_order_id INNER JOIN suppliers s ON s.id=gr.supplier_id INNER JOIN warehouses w ON w.id=gr.warehouse_id WHERE gr.id=? AND gr.company_id=? LIMIT 1 ${lock ? 'FOR UPDATE' : ''}`,
      [id, c],
    )
    return r[0] ?? null
  }
  async lines(q: QueryExecutor, id: number) {
    const [r] = await q.execute<RowDataPacket[]>(
      `SELECT grl.*,i.sku item_code,i.name item_name,i.item_type,i.inventory_account_id,i.purchase_account_id,u.code unit_code FROM goods_receipt_lines grl INNER JOIN items i ON i.id=grl.item_id INNER JOIN units u ON u.id=grl.unit_id WHERE grl.goods_receipt_id=? ORDER BY grl.line_number`,
      [id],
    )
    return r
  }
  async detail(id: number, c: number) {
    const h = await this.find(db, id, c)
    return h ? { ...h, lines: await this.lines(db, id) } : null
  }
  async order(q: QueryExecutor, id: number, c: number) {
    const [r] = await q.execute<RowDataPacket[]>(
      `SELECT * FROM purchase_orders WHERE id=? AND company_id=? AND status IN('confirmed','partially_received','partially_billed') AND deleted_at IS NULL LIMIT 1 FOR UPDATE`,
      [id, c],
    )
    return r[0] ?? null
  }
  async orderLines(q: QueryExecutor, id: number) {
    const [r] = await q.execute<RowDataPacket[]>(
      `SELECT pol.*,i.item_type,i.inventory_account_id,i.purchase_account_id,COALESCE((SELECT SUM(grl.quantity) FROM goods_receipt_lines grl INNER JOIN goods_receipts gr ON gr.id=grl.goods_receipt_id WHERE grl.purchase_order_line_id=pol.id AND gr.status='draft'),0) reserved_quantity FROM purchase_order_lines pol INNER JOIN items i ON i.id=pol.item_id WHERE pol.purchase_order_id=? ORDER BY pol.line_number`,
      [id],
    )
    return r
  }
  async insert(q: QueryExecutor, h: any, lines: any[]) {
    const [r] = await q.execute<ResultSetHeader>(
      `INSERT INTO goods_receipts(company_id,receipt_number,receipt_date,purchase_order_id,supplier_id,warehouse_id,supplier_delivery_number,reference,notes,status,created_by)VALUES(?,?,?,?,?,?,?,?,?,'draft',?)`,
      [
        h.companyId,
        h.number,
        h.date,
        h.orderId,
        h.supplierId,
        h.warehouseId,
        h.deliveryNumber,
        h.reference,
        h.notes,
        h.userId,
      ],
    )
    for (const [i, l] of lines.entries())
      await q.execute(
        `INSERT INTO goods_receipt_lines(goods_receipt_id,purchase_order_line_id,line_number,item_id,description,quantity,unit_id,unit_cost)VALUES(?,?,?,?,?,?,?,?)`,
        [
          r.insertId,
          l.orderLineId,
          i + 1,
          l.itemId,
          l.description,
          l.quantity,
          l.unitId,
          l.unitCost,
        ],
      )
    return r.insertId
  }
  async transition(
    q: QueryExecutor,
    id: number,
    c: number,
    from: string[],
    fields: string,
    values: DatabaseValue[],
  ) {
    const m = from.map(() => '?').join(','),
      [r] = await q.execute<ResultSetHeader>(
        `UPDATE goods_receipts SET ${fields},version=version+1 WHERE id=? AND company_id=? AND status IN(${m})`,
        [...values, id, c, ...from],
      )
    return r.affectedRows > 0
  }
  async setting(q: QueryExecutor, c: number, key: string) {
    const [r] = await q.execute<RowDataPacket[]>(
      'SELECT setting_value FROM settings WHERE company_id=? AND setting_key=? LIMIT 1',
      [c, key],
    )
    return Number(String(r[0]?.setting_value ?? '').replaceAll('"', '')) || null
  }
  async movements(q: QueryExecutor, c: number, id: number) {
    const [r] = await q.execute<RowDataPacket[]>(
      `SELECT * FROM inventory_movements WHERE company_id=? AND transaction_type='goods_receipt' AND transaction_id=? AND is_reversal=FALSE FOR UPDATE`,
      [c, id],
    )
    return r
  }
  async refreshOrder(q: QueryExecutor, orderId: number) {
    const [r] = await q.execute<RowDataPacket[]>(
      'SELECT SUM(received_quantity>0) received,SUM(received_quantity<quantity) remaining,SUM(billed_quantity<quantity) unbilled FROM purchase_order_lines WHERE purchase_order_id=?',
      [orderId],
    )
    const receipt =
        Number(r[0]?.received ?? 0) === 0
          ? 'not_received'
          : Number(r[0]?.remaining ?? 0) === 0
            ? 'received'
            : 'partial',
      status =
        receipt === 'received' && Number(r[0]?.unbilled ?? 0) === 0
          ? 'completed'
          : receipt === 'received'
            ? 'partially_billed'
            : receipt === 'partial'
              ? 'partially_received'
              : 'confirmed'
    await q.execute(
      'UPDATE purchase_orders SET receipt_status=?,status=?,version=version+1 WHERE id=?',
      [receipt, status, orderId],
    )
    return status
  }
}
