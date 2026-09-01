import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { db } from '../config/database'
import type { DatabaseValue, QueryExecutor } from '../types/database'
export class SalesReturnRepository {
  async list(
    companyId: number,
    q: { page: number; limit: number; search?: string; status?: string },
  ) {
    const conditions = ['sr.company_id=?'],
      values: DatabaseValue[] = [companyId]
    if (q.search) {
      conditions.push('(sr.return_number LIKE ? OR sr.reference LIKE ? OR c.name LIKE ?)')
      const s = `%${q.search}%`
      values.push(s, s, s)
    }
    if (q.status) {
      conditions.push('sr.status=?')
      values.push(q.status)
    }
    const where = conditions.join(' AND '),
      offset = (q.page - 1) * q.limit
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT sr.*,c.code customer_code,c.name customer_name,si.invoice_number,COUNT(srl.id) line_count FROM sales_returns sr INNER JOIN customers c ON c.id=sr.customer_id INNER JOIN sales_invoices si ON si.id=sr.sales_invoice_id LEFT JOIN sales_return_lines srl ON srl.sales_return_id=sr.id WHERE ${where} GROUP BY sr.id ORDER BY sr.return_date DESC,sr.id DESC LIMIT ? OFFSET ?`,
      [...values, q.limit, offset],
    )
    const [count] = await db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) total FROM sales_returns sr INNER JOIN customers c ON c.id=sr.customer_id WHERE ${where}`,
      values,
    )
    return { rows, total: Number(count[0]?.total ?? 0), page: q.page, limit: q.limit }
  }
  async find(connection: QueryExecutor, id: number, companyId: number, lock = false) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT sr.*,c.code customer_code,c.name customer_name,c.receivable_account_id,si.invoice_number FROM sales_returns sr INNER JOIN customers c ON c.id=sr.customer_id INNER JOIN sales_invoices si ON si.id=sr.sales_invoice_id WHERE sr.id=? AND sr.company_id=? LIMIT 1 ${lock ? 'FOR UPDATE' : ''}`,
      [id, companyId],
    )
    return rows[0] ?? null
  }
  async lines(connection: QueryExecutor, id: number) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT srl.*,i.sku item_code,i.name item_name,i.item_type,i.inventory_account_id,i.purchase_account_id,u.code unit_code,tc.output_tax_account_id FROM sales_return_lines srl INNER JOIN items i ON i.id=srl.item_id INNER JOIN units u ON u.id=srl.unit_id LEFT JOIN tax_codes tc ON tc.id=srl.tax_code_id WHERE srl.sales_return_id=? ORDER BY srl.line_number`,
      [id],
    )
    return rows
  }
  async detail(id: number, companyId: number) {
    const h = await this.find(db, id, companyId)
    return h ? { ...h, lines: await this.lines(db, id) } : null
  }
  async invoice(connection: QueryExecutor, id: number, companyId: number) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT si.*,c.receivable_account_id FROM sales_invoices si INNER JOIN customers c ON c.id=si.customer_id WHERE si.id=? AND si.company_id=? AND si.status IN ('posted','partially_paid','paid') LIMIT 1 FOR UPDATE`,
      [id, companyId],
    )
    return rows[0] ?? null
  }
  async invoiceLines(connection: QueryExecutor, invoiceId: number) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT sil.*,i.item_type,i.inventory_account_id,i.purchase_account_id,tc.output_tax_account_id,COALESCE((SELECT SUM(srl.quantity) FROM sales_return_lines srl INNER JOIN sales_returns sr ON sr.id=srl.sales_return_id WHERE srl.sales_invoice_line_id=sil.id AND sr.status NOT IN ('rejected','reversed','cancelled')),0) reserved_return_quantity FROM sales_invoice_lines sil INNER JOIN items i ON i.id=sil.item_id LEFT JOIN tax_codes tc ON tc.id=sil.tax_code_id WHERE sil.sales_invoice_id=? ORDER BY sil.line_number`,
      [invoiceId],
    )
    return rows
  }
  async insert(connection: QueryExecutor, h: any, lines: any[]) {
    const [r] = await connection.execute<ResultSetHeader>(
      `INSERT INTO sales_returns(company_id,return_number,return_date,sales_invoice_id,customer_id,warehouse_id,reference,currency,exchange_rate,subtotal,discount,tax,grand_total,base_grand_total,reason,status,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?)`,
      [
        h.companyId,
        h.number,
        h.date,
        h.invoiceId,
        h.customerId,
        h.warehouseId,
        h.reference,
        h.currency,
        h.exchangeRate,
        h.subtotal,
        h.discount,
        h.tax,
        h.grandTotal,
        h.baseGrandTotal,
        h.reason,
        h.userId,
      ],
    )
    for (const [i, l] of lines.entries())
      await connection.execute(
        `INSERT INTO sales_return_lines(sales_return_id,sales_invoice_line_id,line_number,item_id,description,quantity,unit_id,unit_price,discount,tax_code_id,tax_rate,tax_amount,subtotal,base_subtotal,cogs_amount,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          r.insertId,
          l.invoiceLineId,
          i + 1,
          l.itemId,
          l.description,
          l.quantity,
          l.unitId,
          l.unitPrice,
          l.discount,
          l.taxCodeId,
          l.taxRate,
          l.taxAmount,
          l.subtotal,
          l.baseSubtotal,
          l.cogsAmount,
          l.reason,
        ],
      )
    return r.insertId
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
    const [r] = await connection.execute<ResultSetHeader>(
      `UPDATE sales_returns SET ${fields},version=version+1 WHERE id=? AND company_id=? AND status IN (${marks})`,
      [...values, id, companyId, ...from],
    )
    return r.affectedRows > 0
  }
  async movements(connection: QueryExecutor, companyId: number, id: number) {
    const [r] = await connection.execute<RowDataPacket[]>(
      `SELECT * FROM inventory_movements WHERE company_id=? AND transaction_type='sales_return' AND transaction_id=? AND is_reversal=FALSE FOR UPDATE`,
      [companyId, id],
    )
    return r
  }
}
