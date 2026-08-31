import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'

import type { QueryExecutor } from '../types/database'

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
