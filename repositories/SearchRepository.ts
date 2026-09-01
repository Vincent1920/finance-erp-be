import type { RowDataPacket } from 'mysql2/promise'
import { db } from '../config/database'

export const normalizeSearchPagination = (pageInput: unknown, limitInput: unknown) => {
  const page = Number(pageInput)
  const limit = Number(limitInput)
  return {
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    limit: Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20,
  }
}

export class SearchRepository {
  async transactions(
    companyId: number,
    query: { search?: string; status?: string; page: number; limit: number },
  ) {
    const { page, limit } = normalizeSearchPagination(query.page, query.limit)
    const baseValues: Array<string | number> = [
      companyId,
      companyId,
      companyId,
      companyId,
      companyId,
      companyId,
    ]
    const filterValues: Array<string | number> = []
    const conditions: string[] = []
    if (query.search) {
      conditions.push('(number LIKE ? OR party LIKE ? OR type LIKE ? OR reference LIKE ?)')
      const value = `%${query.search}%`
      filterValues.push(value, value, value, value)
    }
    if (query.status) {
      conditions.push('status = ?')
      filterValues.push(query.status)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const union = `SELECT si.id,si.invoice_date date,si.invoice_number number,'Sales Invoice' type,c.name party,si.grand_total amount,si.status,u.name created_by,si.reference,'sales_invoice' entity_type FROM sales_invoices si JOIN customers c ON c.id=si.customer_id JOIN users u ON u.id=si.created_by WHERE si.company_id=?
      UNION ALL SELECT pi.id,pi.invoice_date,pi.invoice_number,'Purchase Invoice',s.name,pi.grand_total,pi.status,u.name,COALESCE(pi.supplier_invoice_number,pi.reference),'purchase_invoice' FROM purchase_invoices pi JOIN suppliers s ON s.id=pi.supplier_id JOIN users u ON u.id=pi.created_by WHERE pi.company_id=?
      UNION ALL SELECT j.id,j.journal_date,j.journal_number,'Journal','Internal',j.total_debit,j.status,u.name,j.reference,'journal' FROM journals j JOIN users u ON u.id=j.created_by WHERE j.company_id=?
      UNION ALL SELECT so.id,so.order_date,so.order_number,'Sales Order',c.name,so.grand_total,so.status,u.name,so.reference,'sales_order' FROM sales_orders so JOIN customers c ON c.id=so.customer_id JOIN users u ON u.id=so.created_by WHERE so.company_id=?
      UNION ALL SELECT po.id,po.order_date,po.order_number,'Purchase Order',s.name,po.grand_total,po.status,u.name,po.supplier_reference,'purchase_order' FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id JOIN users u ON u.id=po.created_by WHERE po.company_id=?
      UNION ALL SELECT gr.id,gr.receipt_date,gr.receipt_number,'Goods Receipt',s.name,0,gr.status,u.name,COALESCE(gr.supplier_delivery_number,gr.reference),'goods_receipt' FROM goods_receipts gr JOIN suppliers s ON s.id=gr.supplier_id JOIN users u ON u.id=gr.created_by WHERE gr.company_id=?`
    const allValues = [...baseValues, ...filterValues]
    const [countRows] = await db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) total FROM (${union}) entries ${where}`,
      allValues,
    )
    const offset = (page - 1) * limit
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT * FROM (${union}) entries ${where} ORDER BY date DESC,id DESC LIMIT ${limit} OFFSET ${offset}`,
      allValues,
    )
    return { rows, page, limit, total: Number(countRows[0]?.total ?? 0) }
  }

  async global(companyId: number, search: string) {
    const value = `%${search}%`
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT * FROM (
        SELECT id,'account' category,CONCAT(code,' · ',name) title,account_type subtitle,'/master/accounts' path FROM accounts WHERE company_id=? AND deleted_at IS NULL AND (code LIKE ? OR name LIKE ?)
        UNION ALL SELECT id,'customer',CONCAT(code,' · ',name),COALESCE(city,''),'/master/customers' FROM customers WHERE company_id=? AND deleted_at IS NULL AND (code LIKE ? OR name LIKE ?)
        UNION ALL SELECT id,'supplier',CONCAT(code,' · ',name),COALESCE(city,''),'/master/suppliers' FROM suppliers WHERE company_id=? AND deleted_at IS NULL AND (code LIKE ? OR name LIKE ?)
        UNION ALL SELECT id,'item',CONCAT(sku,' · ',name),item_type,'/master/items' FROM items WHERE company_id=? AND deleted_at IS NULL AND (sku LIKE ? OR name LIKE ?)
        UNION ALL SELECT id,'sales_invoice',invoice_number,COALESCE(reference,''),CONCAT('/sales/invoices/',id) FROM sales_invoices WHERE company_id=? AND (invoice_number LIKE ? OR reference LIKE ?)
        UNION ALL SELECT id,'purchase_invoice',invoice_number,COALESCE(supplier_invoice_number,''),CONCAT('/purchases/invoices/',id) FROM purchase_invoices WHERE company_id=? AND (invoice_number LIKE ? OR supplier_invoice_number LIKE ? OR reference LIKE ?)
        UNION ALL SELECT id,'journal',journal_number,COALESCE(reference,''),CONCAT('/accounting/journals/',id) FROM journals WHERE company_id=? AND (journal_number LIKE ? OR reference LIKE ? OR description LIKE ?)
      ) results LIMIT 30`,
      [
        companyId,
        value,
        value,
        companyId,
        value,
        value,
        companyId,
        value,
        value,
        companyId,
        value,
        value,
        companyId,
        value,
        value,
        companyId,
        value,
        value,
        value,
        companyId,
        value,
        value,
        value,
      ],
    )
    return rows
  }
}
