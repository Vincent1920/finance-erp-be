import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'

import type { QueryExecutor } from '../types/database'
import { db } from '../config/database'
import type { DatabaseValue } from '../types/database'

export type InvoiceKind = 'sales' | 'purchase'

export interface InvoicePartyRow extends RowDataPacket {
  id: number
  currency: string
  control_account_id: number | null
}

export interface InvoiceItemRow extends RowDataPacket {
  id: number
  sku: string
  name: string
  item_type: 'inventory' | 'service' | 'non_inventory'
  unit_id: number
  sales_account_id: number | null
  inventory_account_id: number | null
  purchase_account_id: number | null
}

export interface InvoiceTaxCodeRow extends RowDataPacket {
  id: number
  code: string
  rate: string | number
  input_tax_account_id: number | null
  output_tax_account_id: number | null
}

export interface InvoiceAccountRow extends RowDataPacket {
  id: number
  code: string
}

export interface InvoiceUnitRow extends RowDataPacket {
  id: number
  code: string
}

export interface InvoiceWarehouseRow extends RowDataPacket {
  id: number
  code: string
}

export interface InvoiceTotalsWrite {
  subtotal: string
  discount: string
  tax: string
  grandTotal: string
  baseSubtotal: string
  baseDiscount: string
  baseTax: string
  baseGrandTotal: string
}

export interface InvoiceLineWrite {
  lineNumber: number
  itemId: number
  description?: string | null
  quantity: string
  unitId: number
  unitPrice: string
  discount: string
  discountPercent: string
  taxCodeId?: number | null
  taxRate: string
  taxAmount: string
  subtotal: string
  baseSubtotal: string
  baseTaxAmount: string
  accountId: number
}

interface InvoiceHeaderWrite {
  companyId: number
  invoiceNumber: string
  invoiceDate: string
  dueDate: string
  warehouseId?: number | null
  reference?: string | null
  notes?: string | null
  currency: string
  exchangeRate: string
  status: 'draft' | 'pending_approval'
  accountingPeriodId: number
  userId: number
  totals: InvoiceTotalsWrite
  lines: InvoiceLineWrite[]
}

export interface SalesInvoiceWrite extends InvoiceHeaderWrite {
  customerId: number
}

export interface PurchaseInvoiceWrite extends InvoiceHeaderWrite {
  supplierId: number
  supplierInvoiceNumber?: string | null
}

function uniqueIds(ids: readonly number[]) {
  return [...new Set(ids)]
}

function placeholders(ids: readonly number[]) {
  return ids.map(() => '?').join(', ')
}

export class InvoiceRepository {
  async listPurchase(
    companyId: number,
    query: {
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
    const conditions = ['pi.company_id=?'],
      values: DatabaseValue[] = [companyId]
    if (query.search) {
      conditions.push(
        '(pi.invoice_number LIKE ? OR pi.supplier_invoice_number LIKE ? OR pi.reference LIKE ? OR s.name LIKE ?)',
      )
      const v = `%${query.search}%`
      values.push(v, v, v, v)
    }
    if (query.status) {
      conditions.push('pi.status=?')
      values.push(query.status)
    }
    if (query.supplier_id) {
      conditions.push('pi.supplier_id=?')
      values.push(query.supplier_id)
    }
    if (query.date_from) {
      conditions.push('pi.invoice_date>=?')
      values.push(query.date_from)
    }
    if (query.date_to) {
      conditions.push('pi.invoice_date<=?')
      values.push(query.date_to)
    }
    const where = conditions.join(' AND '),
      sorts: Record<string, string> = {
        invoice_date: 'pi.invoice_date',
        invoice_number: 'pi.invoice_number',
        due_date: 'pi.due_date',
        grand_total: 'pi.grand_total',
        status: 'pi.status',
        created_at: 'pi.created_at',
      },
      offset = (query.page - 1) * query.limit
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT pi.id,pi.invoice_number,pi.supplier_invoice_number,pi.invoice_date,pi.due_date,pi.reference,pi.currency,pi.grand_total,pi.paid_amount,pi.outstanding_amount,pi.payment_status,pi.status,pi.approval_status,pi.version,pi.purchase_order_id,pi.goods_receipt_id,pi.created_at,s.id supplier_id,s.code supplier_code,s.name supplier_name,COUNT(pil.id) line_count FROM purchase_invoices pi INNER JOIN suppliers s ON s.id=pi.supplier_id LEFT JOIN purchase_invoice_lines pil ON pil.purchase_invoice_id=pi.id WHERE ${where} GROUP BY pi.id ORDER BY ${sorts[query.sort] ?? 'pi.invoice_date'} ${query.order.toUpperCase()},pi.id DESC LIMIT ? OFFSET ?`,
      [...values, query.limit, offset],
    )
    const [count] = await db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) total FROM purchase_invoices pi INNER JOIN suppliers s ON s.id=pi.supplier_id WHERE ${where}`,
      values,
    )
    return { rows, total: Number(count[0]?.total ?? 0), page: query.page, limit: query.limit }
  }
  async findPurchase(connection: QueryExecutor, id: number, companyId: number, lock = false) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT pi.*,s.code supplier_code,s.name supplier_name,s.payable_account_id,w.code warehouse_code,w.name warehouse_name,u.name created_by_name FROM purchase_invoices pi INNER JOIN suppliers s ON s.id=pi.supplier_id LEFT JOIN warehouses w ON w.id=pi.warehouse_id INNER JOIN users u ON u.id=pi.created_by WHERE pi.id=? AND pi.company_id=? LIMIT 1 ${lock ? 'FOR UPDATE' : ''}`,
      [id, companyId],
    )
    return rows[0] ?? null
  }
  async purchaseLines(connection: QueryExecutor, id: number) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT pil.*,i.sku item_code,i.name item_name,i.item_type,i.inventory_account_id,i.purchase_account_id,u.code unit_code,tc.code tax_code,tc.input_tax_account_id FROM purchase_invoice_lines pil INNER JOIN items i ON i.id=pil.item_id INNER JOIN units u ON u.id=pil.unit_id LEFT JOIN tax_codes tc ON tc.id=pil.tax_code_id WHERE pil.purchase_invoice_id=? ORDER BY pil.line_number`,
      [id],
    )
    return rows
  }
  async purchaseDetail(id: number, companyId: number) {
    const h = await this.findPurchase(db, id, companyId)
    return h ? { ...h, lines: await this.purchaseLines(db, id) } : null
  }
  async updatePurchase(
    connection: QueryExecutor,
    id: number,
    version: number,
    input: PurchaseInvoiceWrite,
  ) {
    const [r] = await connection.execute<ResultSetHeader>(
      `UPDATE purchase_invoices SET supplier_invoice_number=?,invoice_date=?,due_date=?,supplier_id=?,warehouse_id=?,reference=?,notes=?,currency=?,exchange_rate=?,subtotal=?,discount=?,tax=?,grand_total=?,base_subtotal=?,base_discount=?,base_tax=?,base_grand_total=?,outstanding_amount=?,accounting_period_id=?,status='draft',approval_status=NULL,rejection_reason=NULL,version=version+1 WHERE id=? AND company_id=? AND status IN('draft','rejected') AND purchase_order_id IS NULL AND goods_receipt_id IS NULL AND version=?`,
      [
        input.supplierInvoiceNumber ?? null,
        input.invoiceDate,
        input.dueDate,
        input.supplierId,
        input.warehouseId ?? null,
        input.reference ?? null,
        input.notes ?? null,
        input.currency,
        input.exchangeRate,
        input.totals.subtotal,
        input.totals.discount,
        input.totals.tax,
        input.totals.grandTotal,
        input.totals.baseSubtotal,
        input.totals.baseDiscount,
        input.totals.baseTax,
        input.totals.baseGrandTotal,
        input.totals.grandTotal,
        input.accountingPeriodId,
        id,
        input.companyId,
        version,
      ],
    )
    if (!r.affectedRows) return false
    await connection.execute('DELETE FROM purchase_invoice_lines WHERE purchase_invoice_id=?', [id])
    await this.insertPurchaseLines(connection, id, input.lines)
    return true
  }
  async transitionPurchase(
    connection: QueryExecutor,
    id: number,
    companyId: number,
    from: string[],
    fields: string,
    values: DatabaseValue[],
  ) {
    const marks = from.map(() => '?').join(','),
      [r] = await connection.execute<ResultSetHeader>(
        `UPDATE purchase_invoices SET ${fields},version=version+1 WHERE id=? AND company_id=? AND status IN(${marks})`,
        [...values, id, companyId, ...from],
      )
    return r.affectedRows > 0
  }
  async purchaseMovements(connection: QueryExecutor, companyId: number, id: number) {
    const [r] = await connection.execute<RowDataPacket[]>(
      `SELECT * FROM inventory_movements WHERE company_id=? AND transaction_type='purchase_invoice' AND transaction_id=? AND is_reversal=FALSE FOR UPDATE`,
      [companyId, id],
    )
    return r
  }
  async listSales(
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
    const conditions = ['si.company_id = ?']
    const values: DatabaseValue[] = [companyId]
    if (query.search) {
      conditions.push('(si.invoice_number LIKE ? OR si.reference LIKE ? OR c.name LIKE ?)')
      const value = `%${query.search}%`
      values.push(value, value, value)
    }
    if (query.status) {
      conditions.push('si.status = ?')
      values.push(query.status)
    }
    if (query.customer_id) {
      conditions.push('si.customer_id = ?')
      values.push(query.customer_id)
    }
    if (query.date_from) {
      conditions.push('si.invoice_date >= ?')
      values.push(query.date_from)
    }
    if (query.date_to) {
      conditions.push('si.invoice_date <= ?')
      values.push(query.date_to)
    }
    const where = conditions.join(' AND ')
    const sorts: Record<string, string> = {
      invoice_date: 'si.invoice_date',
      invoice_number: 'si.invoice_number',
      due_date: 'si.due_date',
      grand_total: 'si.grand_total',
      status: 'si.status',
      created_at: 'si.created_at',
    }
    const offset = (query.page - 1) * query.limit
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT si.id, si.invoice_number, si.invoice_date, si.due_date, si.reference, si.currency, si.grand_total, si.paid_amount, si.outstanding_amount, si.payment_status, si.status, si.approval_status, si.version, si.created_at, c.id AS customer_id, c.code AS customer_code, c.name AS customer_name, COUNT(sil.id) AS line_count FROM sales_invoices si INNER JOIN customers c ON c.id = si.customer_id LEFT JOIN sales_invoice_lines sil ON sil.sales_invoice_id = si.id WHERE ${where} GROUP BY si.id ORDER BY ${sorts[query.sort] ?? 'si.invoice_date'} ${query.order.toUpperCase()}, si.id DESC LIMIT ? OFFSET ?`,
      [...values, query.limit, offset],
    )
    const [counts] = await db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM sales_invoices si INNER JOIN customers c ON c.id = si.customer_id WHERE ${where}`,
      values,
    )
    return { rows, total: Number(counts[0]?.total ?? 0), page: query.page, limit: query.limit }
  }

  async findSales(connection: QueryExecutor, id: number, companyId: number, lock = false) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT si.*, c.code AS customer_code, c.name AS customer_name, c.receivable_account_id, w.code AS warehouse_code, w.name AS warehouse_name, u.name AS created_by_name FROM sales_invoices si INNER JOIN customers c ON c.id = si.customer_id LEFT JOIN warehouses w ON w.id = si.warehouse_id INNER JOIN users u ON u.id = si.created_by WHERE si.id = ? AND si.company_id = ? LIMIT 1 ${lock ? 'FOR UPDATE' : ''}`,
      [id, companyId],
    )
    return rows[0] ?? null
  }

  async salesLines(connection: QueryExecutor, id: number) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT sil.*, i.sku AS item_code, i.name AS item_name, i.item_type, i.inventory_account_id, i.purchase_account_id, u.code AS unit_code, tc.code AS tax_code, tc.output_tax_account_id FROM sales_invoice_lines sil INNER JOIN items i ON i.id = sil.item_id INNER JOIN units u ON u.id = sil.unit_id LEFT JOIN tax_codes tc ON tc.id = sil.tax_code_id WHERE sil.sales_invoice_id = ? ORDER BY sil.line_number`,
      [id],
    )
    return rows
  }

  async salesDetail(id: number, companyId: number) {
    const header = await this.findSales(db, id, companyId)
    return header ? { ...header, lines: await this.salesLines(db, id) } : null
  }

  async updateSales(
    connection: QueryExecutor,
    id: number,
    version: number,
    input: SalesInvoiceWrite,
  ) {
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE sales_invoices SET invoice_date=?, due_date=?, customer_id=?, warehouse_id=?, reference=?, notes=?, currency=?, exchange_rate=?, subtotal=?, discount=?, tax=?, grand_total=?, base_subtotal=?, base_discount=?, base_tax=?, base_grand_total=?, outstanding_amount=?, accounting_period_id=?, status='draft', approval_status=NULL, rejection_reason=NULL, version=version+1 WHERE id=? AND company_id=? AND status IN ('draft','rejected') AND sales_order_id IS NULL AND version=?`,
      [
        input.invoiceDate,
        input.dueDate,
        input.customerId,
        input.warehouseId ?? null,
        input.reference ?? null,
        input.notes ?? null,
        input.currency,
        input.exchangeRate,
        input.totals.subtotal,
        input.totals.discount,
        input.totals.tax,
        input.totals.grandTotal,
        input.totals.baseSubtotal,
        input.totals.baseDiscount,
        input.totals.baseTax,
        input.totals.baseGrandTotal,
        input.totals.grandTotal,
        input.accountingPeriodId,
        id,
        input.companyId,
        version,
      ],
    )
    if (!result.affectedRows) return false
    await connection.execute('DELETE FROM sales_invoice_lines WHERE sales_invoice_id = ?', [id])
    await this.insertSalesLines(connection, id, input.lines)
    return true
  }

  async transitionSales(
    connection: QueryExecutor,
    id: number,
    companyId: number,
    from: string[],
    fields: string,
    values: DatabaseValue[],
  ) {
    const marks = from.map(() => '?').join(',')
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE sales_invoices SET ${fields}, version=version+1 WHERE id=? AND company_id=? AND status IN (${marks})`,
      [...values, id, companyId, ...from],
    )
    return result.affectedRows > 0
  }

  async salesMovements(connection: QueryExecutor, companyId: number, invoiceId: number) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT * FROM inventory_movements WHERE company_id=? AND transaction_type='sales_invoice' AND transaction_id=? AND is_reversal=FALSE ORDER BY id FOR UPDATE`,
      [companyId, invoiceId],
    )
    return rows
  }

  async releaseSalesOrderInvoice(connection: QueryExecutor, invoiceId: number, orderId: number) {
    const [lines] = await connection.execute<RowDataPacket[]>(
      'SELECT sales_order_line_id, quantity FROM sales_invoice_lines WHERE sales_invoice_id=? AND sales_order_line_id IS NOT NULL',
      [invoiceId],
    )
    for (const line of lines) {
      await connection.execute(
        'UPDATE sales_order_lines SET invoiced_quantity=GREATEST(0, invoiced_quantity-?) WHERE id=? AND sales_order_id=?',
        [line.quantity, line.sales_order_line_id, orderId],
      )
    }
    const [counts] = await connection.execute<RowDataPacket[]>(
      'SELECT SUM(invoiced_quantity > 0) AS invoiced, SUM(invoiced_quantity < quantity) AS remaining FROM sales_order_lines WHERE sales_order_id=?',
      [orderId],
    )
    const status =
      Number(counts[0]?.invoiced ?? 0) === 0
        ? 'confirmed'
        : Number(counts[0]?.remaining ?? 0) === 0
          ? 'invoiced'
          : 'partially_invoiced'
    await connection.execute('UPDATE sales_orders SET status=?, version=version+1 WHERE id=?', [
      status,
      orderId,
    ])
  }
  async findParty(
    connection: QueryExecutor,
    kind: InvoiceKind,
    companyId: number,
    partyId: number,
  ) {
    const table = kind === 'sales' ? 'customers' : 'suppliers'
    const accountColumn = kind === 'sales' ? 'receivable_account_id' : 'payable_account_id'
    const [rows] = await connection.execute<InvoicePartyRow[]>(
      `SELECT id, currency, ${accountColumn} AS control_account_id
       FROM ${table}
       WHERE id = ? AND company_id = ? AND is_active = TRUE AND deleted_at IS NULL
       LIMIT 1`,
      [partyId, companyId],
    )
    return rows[0] ?? null
  }

  async findWarehouse(connection: QueryExecutor, companyId: number, warehouseId: number) {
    const [rows] = await connection.execute<InvoiceWarehouseRow[]>(
      `SELECT id, code
       FROM warehouses
       WHERE id = ? AND company_id = ? AND is_active = TRUE
       LIMIT 1`,
      [warehouseId, companyId],
    )
    return rows[0] ?? null
  }

  async findItems(connection: QueryExecutor, companyId: number, itemIds: readonly number[]) {
    const ids = uniqueIds(itemIds)
    if (ids.length === 0) return []
    const [rows] = await connection.execute<InvoiceItemRow[]>(
      `SELECT id, sku, name, item_type, unit_id, sales_account_id,
              inventory_account_id, purchase_account_id
       FROM items
       WHERE company_id = ? AND id IN (${placeholders(ids)})
         AND is_active = TRUE AND deleted_at IS NULL`,
      [companyId, ...ids],
    )
    return rows
  }

  async findUnits(connection: QueryExecutor, companyId: number, unitIds: readonly number[]) {
    const ids = uniqueIds(unitIds)
    if (ids.length === 0) return []
    const [rows] = await connection.execute<InvoiceUnitRow[]>(
      `SELECT id, code
       FROM units
       WHERE company_id = ? AND id IN (${placeholders(ids)}) AND is_active = TRUE`,
      [companyId, ...ids],
    )
    return rows
  }

  async findTaxCodes(connection: QueryExecutor, companyId: number, taxCodeIds: readonly number[]) {
    const ids = uniqueIds(taxCodeIds)
    if (ids.length === 0) return []
    const [rows] = await connection.execute<InvoiceTaxCodeRow[]>(
      `SELECT id, code, rate, input_tax_account_id, output_tax_account_id
       FROM tax_codes
       WHERE company_id = ? AND id IN (${placeholders(ids)}) AND is_active = TRUE`,
      [companyId, ...ids],
    )
    return rows
  }

  async findAccounts(connection: QueryExecutor, companyId: number, accountIds: readonly number[]) {
    const ids = uniqueIds(accountIds)
    if (ids.length === 0) return []
    const [rows] = await connection.execute<InvoiceAccountRow[]>(
      `SELECT id, code
       FROM accounts
       WHERE company_id = ? AND id IN (${placeholders(ids)})
         AND is_active = TRUE AND is_posting = TRUE AND deleted_at IS NULL`,
      [companyId, ...ids],
    )
    return rows
  }

  async findSalesDuplicate(connection: QueryExecutor, companyId: number, invoiceNumber: string) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT id, customer_id
       FROM sales_invoices
       WHERE company_id = ? AND invoice_number = ?
       LIMIT 1
       FOR UPDATE`,
      [companyId, invoiceNumber],
    )
    return rows[0] ?? null
  }

  async findPurchaseDuplicate(
    connection: QueryExecutor,
    companyId: number,
    invoiceNumber: string,
    supplierId: number,
    supplierInvoiceNumber?: string | null,
  ) {
    const values: Array<string | number> = [companyId, invoiceNumber]
    let external = ''
    if (supplierInvoiceNumber) {
      external = 'OR (supplier_id = ? AND supplier_invoice_number = ?)'
      values.push(supplierId, supplierInvoiceNumber)
    }
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT id, supplier_id, supplier_invoice_number
       FROM purchase_invoices
       WHERE company_id = ? AND (invoice_number = ? ${external})
       LIMIT 1
       FOR UPDATE`,
      values,
    )
    return rows[0] ?? null
  }

  async insertSales(connection: QueryExecutor, input: SalesInvoiceWrite) {
    const submitted = input.status === 'pending_approval'
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO sales_invoices (
         company_id, invoice_number, invoice_date, due_date, customer_id, warehouse_id,
         reference, notes, currency, exchange_rate, subtotal, discount, tax, grand_total,
         base_subtotal, base_discount, base_tax, base_grand_total, paid_amount,
         outstanding_amount, payment_status, status, approval_status, accounting_period_id,
         created_by, submitted_by, submitted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'unpaid', ?, ?, ?, ?, ?, ?)`,
      [
        input.companyId,
        input.invoiceNumber,
        input.invoiceDate,
        input.dueDate,
        input.customerId,
        input.warehouseId ?? null,
        input.reference ?? null,
        input.notes ?? null,
        input.currency,
        input.exchangeRate,
        input.totals.subtotal,
        input.totals.discount,
        input.totals.tax,
        input.totals.grandTotal,
        input.totals.baseSubtotal,
        input.totals.baseDiscount,
        input.totals.baseTax,
        input.totals.baseGrandTotal,
        input.totals.grandTotal,
        input.status,
        submitted ? 'pending' : null,
        input.accountingPeriodId,
        input.userId,
        submitted ? input.userId : null,
        submitted ? new Date() : null,
      ],
    )
    await this.insertSalesLines(connection, result.insertId, input.lines)
    return result.insertId
  }

  async insertPurchase(connection: QueryExecutor, input: PurchaseInvoiceWrite) {
    const submitted = input.status === 'pending_approval'
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO purchase_invoices (
         company_id, invoice_number, supplier_invoice_number, invoice_date, due_date,
         supplier_id, warehouse_id, reference, notes, currency, exchange_rate,
         subtotal, discount, tax, grand_total, base_subtotal, base_discount, base_tax,
         base_grand_total, paid_amount, outstanding_amount, payment_status, status,
         approval_status, accounting_period_id, created_by, submitted_by, submitted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'unpaid', ?, ?, ?, ?, ?, ?)`,
      [
        input.companyId,
        input.invoiceNumber,
        input.supplierInvoiceNumber ?? null,
        input.invoiceDate,
        input.dueDate,
        input.supplierId,
        input.warehouseId ?? null,
        input.reference ?? null,
        input.notes ?? null,
        input.currency,
        input.exchangeRate,
        input.totals.subtotal,
        input.totals.discount,
        input.totals.tax,
        input.totals.grandTotal,
        input.totals.baseSubtotal,
        input.totals.baseDiscount,
        input.totals.baseTax,
        input.totals.baseGrandTotal,
        input.totals.grandTotal,
        input.status,
        submitted ? 'pending' : null,
        input.accountingPeriodId,
        input.userId,
        submitted ? input.userId : null,
        submitted ? new Date() : null,
      ],
    )
    await this.insertPurchaseLines(connection, result.insertId, input.lines)
    return result.insertId
  }

  private async insertSalesLines(
    connection: QueryExecutor,
    invoiceId: number,
    lines: InvoiceLineWrite[],
  ) {
    for (const line of lines) {
      await connection.execute(
        `INSERT INTO sales_invoice_lines (
           sales_invoice_id, line_number, item_id, description, quantity, unit_id,
           unit_price, discount, discount_percent, tax_code_id, tax_rate, tax_amount,
           subtotal, base_subtotal, base_tax_amount, cogs_amount, revenue_account_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [
          invoiceId,
          line.lineNumber,
          line.itemId,
          line.description ?? null,
          line.quantity,
          line.unitId,
          line.unitPrice,
          line.discount,
          line.discountPercent,
          line.taxCodeId ?? null,
          line.taxRate,
          line.taxAmount,
          line.subtotal,
          line.baseSubtotal,
          line.baseTaxAmount,
          line.accountId,
        ],
      )
    }
  }

  private async insertPurchaseLines(
    connection: QueryExecutor,
    invoiceId: number,
    lines: InvoiceLineWrite[],
  ) {
    for (const line of lines) {
      await connection.execute(
        `INSERT INTO purchase_invoice_lines (
           purchase_invoice_id, line_number, item_id, description, quantity, unit_id,
           unit_price, discount, discount_percent, tax_code_id, tax_rate, tax_amount,
           subtotal, base_subtotal, base_tax_amount, expense_account_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          invoiceId,
          line.lineNumber,
          line.itemId,
          line.description ?? null,
          line.quantity,
          line.unitId,
          line.unitPrice,
          line.discount,
          line.discountPercent,
          line.taxCodeId ?? null,
          line.taxRate,
          line.taxAmount,
          line.subtotal,
          line.baseSubtotal,
          line.baseTaxAmount,
          line.accountId,
        ],
      )
    }
  }
}
