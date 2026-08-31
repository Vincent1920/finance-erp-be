import type { RowDataPacket } from 'mysql2/promise'

import { db } from '../../config/database'
import type { QueryExecutor } from '../../types/database'
import { addDecimal, compareDecimal, subtractDecimal, sumScaled } from '../../utils/decimal'
import { importRowSchemas } from '../../validators/import.validator'
import type {
  PreviewIssue,
  PreviewRowStatus,
  PreviewRowWrite,
} from '../../repositories/ImportRepository'
import type { ImportType } from './ImportDefinitions'
import type { ParsedImportRow } from './TabularFileService'

export type ReferenceRow = RowDataPacket & Record<string, unknown> & { id: number }

export interface ReferenceCatalog {
  accounts: Map<string, ReferenceRow>
  customers: Map<string, ReferenceRow>
  suppliers: Map<string, ReferenceRow>
  items: Map<string, ReferenceRow>
  units: Map<string, ReferenceRow>
  warehouses: Map<string, ReferenceRow>
  taxes: Map<string, ReferenceRow>
  costCenters: Map<string, ReferenceRow>
  projects: Map<string, ReferenceRow>
  bankAccounts: Map<string, ReferenceRow>
  openPeriods: Array<{ start: string; end: string }>
}

export interface ValidatedImportPreview {
  rows: PreviewRowWrite[]
  summary: { validRows: number; warningRows: number; errorRows: number }
}

const normalizedCode = (value: unknown) => String(value ?? '').trim().toUpperCase()
const valueText = (value: unknown) => {
  if (value === undefined || value === null) return null
  return String(value).slice(0, 1000)
}
const dateOnly = (value: unknown) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '').slice(0, 10)

const toMap = (rows: ReferenceRow[], key: string) =>
  new Map(rows.map((row) => [normalizedCode(row[key]), row]))

async function selectRows(connection: QueryExecutor, sql: string, companyId: number) {
  const [rows] = await connection.execute<ReferenceRow[]>(sql, [companyId])
  return rows
}

export async function loadReferenceCatalog(
  companyId: number,
  connection: QueryExecutor = db,
): Promise<ReferenceCatalog> {
  const [accounts, customers, suppliers, items, units, warehouses, taxes, costCenters, projects, bankAccounts, periods] =
    await Promise.all([
      selectRows(
        connection,
        `SELECT id, code, name, account_type, normal_balance, is_posting,
                allow_manual_journal, parent_id
         FROM accounts
         WHERE company_id = ? AND is_active = TRUE AND deleted_at IS NULL`,
        companyId,
      ),
      selectRows(
        connection,
        `SELECT id, code, name, currency, receivable_account_id
         FROM customers
         WHERE company_id = ? AND is_active = TRUE AND deleted_at IS NULL`,
        companyId,
      ),
      selectRows(
        connection,
        `SELECT id, code, name, currency, payable_account_id
         FROM suppliers
         WHERE company_id = ? AND is_active = TRUE AND deleted_at IS NULL`,
        companyId,
      ),
      selectRows(
        connection,
        `SELECT id, sku, name, item_type, unit_id, sales_account_id,
                inventory_account_id, cogs_account_id, purchase_account_id,
                purchase_price, sales_price
         FROM items
         WHERE company_id = ? AND is_active = TRUE AND deleted_at IS NULL`,
        companyId,
      ),
      selectRows(
        connection,
        'SELECT id, code, name FROM units WHERE company_id = ? AND is_active = TRUE',
        companyId,
      ),
      selectRows(
        connection,
        'SELECT id, code, name FROM warehouses WHERE company_id = ? AND is_active = TRUE',
        companyId,
      ),
      selectRows(
        connection,
        `SELECT id, code, name, rate, input_tax_account_id, output_tax_account_id
         FROM tax_codes WHERE company_id = ? AND is_active = TRUE`,
        companyId,
      ),
      selectRows(
        connection,
        'SELECT id, code, name FROM cost_centers WHERE company_id = ? AND is_active = TRUE',
        companyId,
      ),
      selectRows(
        connection,
        `SELECT id, code, name FROM projects
         WHERE company_id = ? AND COALESCE(status, 'active') <> 'inactive'`,
        companyId,
      ),
      selectRows(
        connection,
        `SELECT id, code, bank_name, account_number, currency, gl_account_id
         FROM bank_accounts
         WHERE company_id = ? AND is_active = TRUE AND deleted_at IS NULL`,
        companyId,
      ),
      selectRows(
        connection,
        `SELECT id, start_date, end_date FROM accounting_periods
         WHERE company_id = ? AND status = 'open'`,
        companyId,
      ),
    ])

  return {
    accounts: toMap(accounts, 'code'),
    customers: toMap(customers, 'code'),
    suppliers: toMap(suppliers, 'code'),
    items: toMap(items, 'sku'),
    units: toMap(units, 'code'),
    warehouses: toMap(warehouses, 'code'),
    taxes: toMap(taxes, 'code'),
    costCenters: toMap(costCenters, 'code'),
    projects: toMap(projects, 'code'),
    bankAccounts: toMap(bankAccounts, 'code'),
    openPeriods: periods.map((row) => ({
      start: dateOnly(row.start_date),
      end: dateOnly(row.end_date),
    })),
  }
}

function metadata(type: ImportType, data: Record<string, unknown>) {
  switch (type) {
    case 'customer':
      return {
        key: normalizedCode(data.customer_code),
        reference: String(data.customer_code ?? ''),
        description: String(data.customer_name ?? ''),
      }
    case 'supplier':
      return {
        key: normalizedCode(data.supplier_code),
        reference: String(data.supplier_code ?? ''),
        description: String(data.supplier_name ?? ''),
      }
    case 'item':
      return {
        key: normalizedCode(data.item_code),
        reference: String(data.item_code ?? ''),
        description: String(data.item_name ?? ''),
      }
    case 'chart_of_accounts':
      return {
        key: normalizedCode(data.account_code),
        reference: String(data.account_code ?? ''),
        description: String(data.account_name ?? ''),
      }
    case 'sales':
      return {
        key: `${normalizedCode(data.invoice_number)}|${normalizedCode(data.customer_code)}`,
        reference: String(data.invoice_number ?? ''),
        description: `${String(data.customer_code ?? '')} · ${String(data.description ?? '')}`,
      }
    case 'purchase':
      return {
        key: `${normalizedCode(data.invoice_number)}|${normalizedCode(data.supplier_code)}`,
        reference: String(data.invoice_number ?? ''),
        description: `${String(data.supplier_code ?? '')} · ${String(data.description ?? '')}`,
      }
    case 'journal':
      return {
        key: `${String(data.journal_date ?? '')}|${normalizedCode(data.reference)}`,
        reference: String(data.reference ?? ''),
        description: String(data.description ?? ''),
      }
    case 'opening_balance':
      return {
        key: `${String(data.as_of_date ?? '')}|${normalizedCode(data.reference) || 'OPENING'}`,
        reference: String(data.reference ?? 'Opening balance'),
        description: String(data.description ?? 'Opening balance'),
      }
    case 'inventory':
      return {
        key: `${normalizedCode(data.item_code)}|${normalizedCode(data.warehouse)}`,
        reference: String(data.reference ?? data.item_code ?? ''),
        description: String(data.description ?? data.item_code ?? ''),
      }
    case 'bank_statement':
      return {
        key: `${normalizedCode(data.statement_number)}|${normalizedCode(data.bank_account_code)}`,
        reference: String(data.statement_number ?? ''),
        description: String(data.description ?? ''),
      }
  }
}

function issue(
  row: PreviewRowWrite,
  field: string | null,
  severity: 'warning' | 'error',
  code: string,
  message: string,
  value?: unknown,
) {
  if (row.issues.some((item) => item.field === field && item.code === code)) return
  row.issues.push({ field, value: valueText(value ?? (field ? row.data[field] : null)), severity, code, message })
}

function hasOpenPeriod(catalog: ReferenceCatalog, date: unknown) {
  const value = String(date ?? '')
  return catalog.openPeriods.some((period) => value >= period.start && value <= period.end)
}

function requireReference(
  row: PreviewRowWrite,
  map: Map<string, ReferenceRow>,
  field: string,
  label: string,
  required = true,
) {
  const value = row.data[field]
  if (!required && !normalizedCode(value)) return null
  const found = map.get(normalizedCode(value)) ?? null
  if (!found) issue(row, field, 'error', 'reference_not_found', `${label} tidak ditemukan atau tidak aktif`)
  return found
}

function validateAccount(
  row: PreviewRowWrite,
  catalog: ReferenceCatalog,
  field: string,
  label: string,
  required = false,
  manual = false,
) {
  const account = requireReference(row, catalog.accounts, field, label, required)
  if (!account) return null
  if (!Boolean(account.is_posting)) {
    issue(row, field, 'error', 'account_not_posting', `${label} harus berupa akun posting`)
  }
  if (manual && !Boolean(account.allow_manual_journal)) {
    issue(row, field, 'error', 'manual_journal_disabled', `${label} tidak mengizinkan jurnal manual`)
  }
  return account
}

function statusFor(issues: PreviewIssue[]): PreviewRowStatus {
  if (issues.some((item) => item.severity === 'error')) return 'error'
  return issues.length ? 'warning' : 'valid'
}

async function existingTransactionKeys(
  connection: QueryExecutor,
  companyId: number,
  type: ImportType,
  rows: PreviewRowWrite[],
) {
  const result = new Map<string, string>()
  const references = [...new Set(rows.map((row) => row.reference).filter(Boolean))] as string[]
  for (let offset = 0; offset < references.length; offset += 500) {
    const chunk = references.slice(offset, offset + 500)
    if (!chunk.length) continue
    const marks = chunk.map(() => '?').join(',')
    let sql = ''
    if (type === 'sales') {
      sql = `SELECT si.invoice_number AS reference, c.code AS party
             FROM sales_invoices si INNER JOIN customers c ON c.id = si.customer_id
             WHERE si.company_id = ? AND si.invoice_number IN (${marks})`
    } else if (type === 'purchase') {
      sql = `SELECT pi.invoice_number AS reference, s.code AS party
             FROM purchase_invoices pi INNER JOIN suppliers s ON s.id = pi.supplier_id
             WHERE pi.company_id = ? AND pi.invoice_number IN (${marks})`
    } else if (type === 'journal') {
      sql = `SELECT reference, journal_date AS transaction_date
             FROM journals WHERE company_id = ? AND reference IN (${marks})
               AND status <> 'cancelled'`
    } else if (type === 'bank_statement') {
      sql = `SELECT bs.statement_number AS reference, ba.code AS party
             FROM bank_statements bs INNER JOIN bank_accounts ba ON ba.id = bs.bank_account_id
             WHERE bs.company_id = ? AND bs.statement_number IN (${marks})`
    } else {
      return result
    }
    const [found] = await connection.execute<ReferenceRow[]>(sql, [companyId, ...chunk])
    for (const item of found) {
      const reference = normalizedCode(item.reference)
      if (type === 'journal') {
        result.set(`${dateOnly(item.transaction_date)}|${reference}`, reference)
      } else {
        result.set(`${reference}|${normalizedCode(item.party)}`, reference)
        result.set(`reference:${reference}`, normalizedCode(item.party))
      }
    }
  }
  return result
}

export class ImportValidationService {
  async validate(
    companyId: number,
    type: ImportType,
    parsedRows: ParsedImportRow[],
    connection: QueryExecutor = db,
  ): Promise<ValidatedImportPreview> {
    const catalog = await loadReferenceCatalog(companyId, connection)
    const rows: PreviewRowWrite[] = parsedRows.map((source) => {
      const result = importRowSchemas[type].safeParse(source.data)
      const data = result.success ? (result.data as Record<string, unknown>) : source.data
      const meta = metadata(type, data)
      const row: PreviewRowWrite = {
        rowNumber: source.rowNumber,
        status: 'valid',
        documentKey: meta.key || null,
        reference: meta.reference.slice(0, 191) || null,
        description: meta.description.slice(0, 500) || null,
        isDuplicate: false,
        data,
        issues: [],
      }
      if (!result.success) {
        for (const zodIssue of result.error.issues) {
          const field = typeof zodIssue.path[0] === 'string' ? zodIssue.path[0] : null
          issue(row, field, 'error', `schema_${zodIssue.code}`, zodIssue.message, field ? source.data[field] : null)
        }
      }
      return row
    })

    this.validateReferences(type, rows, catalog)
    this.validateWithinFile(type, rows)
    await this.validateDatabaseDuplicates(connection, companyId, type, rows)
    if (type === 'chart_of_accounts') this.validateAccountHierarchy(rows, catalog)
    if (type === 'inventory') await this.validateExistingInventory(connection, companyId, rows, catalog)
    this.propagateDocumentErrors(type, rows)

    for (const row of rows) row.status = statusFor(row.issues)
    return {
      rows,
      summary: {
        validRows: rows.filter((row) => row.status === 'valid').length,
        warningRows: rows.filter((row) => row.status === 'warning').length,
        errorRows: rows.filter((row) => row.status === 'error').length,
      },
    }
  }

  private validateReferences(type: ImportType, rows: PreviewRowWrite[], catalog: ReferenceCatalog) {
    for (const row of rows) {
      if (row.issues.some((item) => item.code.startsWith('schema_'))) continue
      const data = row.data
      if (type === 'customer') {
        validateAccount(row, catalog, 'receivable_account_code', 'Akun piutang')
        if (compareDecimal(String(data.opening_balance ?? 0), '0') !== 0) {
          validateAccount(row, catalog, 'receivable_account_code', 'Akun piutang', true)
          validateAccount(row, catalog, 'opening_balance_offset_account_code', 'Akun lawan saldo awal', true)
          if (!data.opening_balance_date) issue(row, 'opening_balance_date', 'error', 'required_for_opening', 'Tanggal saldo awal wajib diisi')
        }
      } else if (type === 'supplier') {
        validateAccount(row, catalog, 'payable_account_code', 'Akun utang')
        if (compareDecimal(String(data.opening_balance ?? 0), '0') !== 0) {
          validateAccount(row, catalog, 'payable_account_code', 'Akun utang', true)
          validateAccount(row, catalog, 'opening_balance_offset_account_code', 'Akun lawan saldo awal', true)
          if (!data.opening_balance_date) issue(row, 'opening_balance_date', 'error', 'required_for_opening', 'Tanggal saldo awal wajib diisi')
        }
      } else if (type === 'item') {
        requireReference(row, catalog.units, 'unit', 'Satuan')
        for (const [field, label] of [
          ['sales_account_code', 'Akun penjualan'],
          ['inventory_account_code', 'Akun persediaan'],
          ['cogs_account_code', 'Akun HPP'],
          ['purchase_account_code', 'Akun pembelian'],
        ] as const) validateAccount(row, catalog, field, label)
        if (compareDecimal(String(data.opening_stock ?? 0), '0', 4) > 0) {
          if (data.item_type !== 'inventory') issue(row, 'opening_stock', 'error', 'inventory_type_required', 'Opening stock hanya untuk item inventory')
          requireReference(row, catalog.warehouses, 'warehouse', 'Gudang')
          validateAccount(row, catalog, 'inventory_account_code', 'Akun persediaan', true)
          if (!data.opening_stock_date) issue(row, 'opening_stock_date', 'error', 'required_for_opening', 'Tanggal opening stock wajib diisi')
        }
      } else if (type === 'chart_of_accounts') {
        const parentCode = normalizedCode(data.parent_code)
        if (parentCode && parentCode === normalizedCode(data.account_code)) {
          issue(row, 'parent_code', 'error', 'self_parent', 'Akun tidak dapat menjadi induknya sendiri')
        }
      } else if (type === 'opening_balance') {
        validateAccount(row, catalog, 'account_code', 'Account Code', true, true)
      } else if (type === 'sales' || type === 'purchase') {
        const party = requireReference(
          row,
          type === 'sales' ? catalog.customers : catalog.suppliers,
          type === 'sales' ? 'customer_code' : 'supplier_code',
          type === 'sales' ? 'Customer' : 'Supplier',
        )
        if (party) {
          const accountId = type === 'sales' ? party.receivable_account_id : party.payable_account_id
          if (!accountId) issue(row, type === 'sales' ? 'customer_code' : 'supplier_code', 'error', 'control_account_missing', `${type === 'sales' ? 'Customer' : 'Supplier'} belum memiliki akun kontrol`)
        }
        const item = requireReference(row, catalog.items, 'item_code', 'Item')
        if (item) {
          const accountId = type === 'sales'
            ? item.sales_account_id
            : item.item_type === 'inventory'
              ? item.inventory_account_id
              : item.purchase_account_id
          if (!accountId) issue(row, 'item_code', 'error', 'item_account_missing', 'Akun transaksi item belum dikonfigurasi')
          if (item.item_type === 'inventory' && !data.warehouse) issue(row, 'warehouse', 'error', 'warehouse_required', 'Gudang wajib untuk item inventory')
        }
        if (data.warehouse) requireReference(row, catalog.warehouses, 'warehouse', 'Gudang')
        const tax = data.tax_code ? requireReference(row, catalog.taxes, 'tax_code', 'Kode pajak') : null
        if (tax && compareDecimal(String(tax.rate ?? 0), '0', 4) > 0) {
          const taxAccount = type === 'sales' ? tax.output_tax_account_id : tax.input_tax_account_id
          if (!taxAccount) issue(row, 'tax_code', 'error', 'tax_account_missing', 'Akun pajak belum dikonfigurasi')
        }
        if (!hasOpenPeriod(catalog, data.transaction_date)) issue(row, 'transaction_date', 'error', 'period_not_open', 'Periode akuntansi belum dibuat atau tidak terbuka')
      } else if (type === 'journal') {
        validateAccount(row, catalog, 'account_code', 'Account Code', true, true)
        if (data.cost_center) requireReference(row, catalog.costCenters, 'cost_center', 'Cost center')
        if (data.project) requireReference(row, catalog.projects, 'project', 'Project')
        if (!hasOpenPeriod(catalog, data.journal_date)) issue(row, 'journal_date', 'error', 'period_not_open', 'Periode akuntansi belum dibuat atau tidak terbuka')
      } else if (type === 'inventory') {
        const item = requireReference(row, catalog.items, 'item_code', 'Item')
        if (item && item.item_type !== 'inventory') issue(row, 'item_code', 'error', 'inventory_type_required', 'Hanya item inventory yang dapat mempunyai opening stock')
        requireReference(row, catalog.warehouses, 'warehouse', 'Gudang')
      } else if (type === 'bank_statement') {
        requireReference(row, catalog.bankAccounts, 'bank_account_code', 'Rekening bank')
      }
    }

    if (type === 'chart_of_accounts') {
      const fileCodes = new Set(rows.map((row) => normalizedCode(row.data.account_code)))
      for (const row of rows) {
        const parent = normalizedCode(row.data.parent_code)
        if (parent && !catalog.accounts.has(parent) && !fileCodes.has(parent)) {
          issue(row, 'parent_code', 'error', 'reference_not_found', 'Akun induk tidak ditemukan di database atau file')
        }
      }
    }
  }

  private validateWithinFile(type: ImportType, rows: PreviewRowWrite[]) {
    if (['customer', 'supplier', 'item', 'chart_of_accounts'].includes(type)) {
      const seen = new Set<string>()
      for (const row of rows) {
        if (!row.documentKey) continue
        if (seen.has(row.documentKey)) {
          row.isDuplicate = true
          issue(row, null, 'warning', 'duplicate_in_file', 'Kode duplikat di dalam file; baris ini akan dilewati')
        } else seen.add(row.documentKey)
      }
    }

    if (type === 'sales' || type === 'purchase') {
      const byInvoice = new Map<string, PreviewRowWrite[]>()
      for (const row of rows) {
        const invoice = normalizedCode(row.data.invoice_number)
        const group = byInvoice.get(invoice) ?? []
        group.push(row)
        byInvoice.set(invoice, group)
      }
      for (const group of byInvoice.values()) {
        const partyField = type === 'sales' ? 'customer_code' : 'supplier_code'
        const parties = new Set(group.map((row) => normalizedCode(row.data[partyField])))
        const headerFields = [partyField, 'transaction_date', 'due_date', 'warehouse']
        for (const field of headerFields) {
          const values = new Set(group.map((row) => normalizedCode(row.data[field])))
          if (values.size > 1) {
            for (const row of group) issue(row, field, 'error', 'inconsistent_document_header', `Nilai ${field} harus konsisten dalam satu invoice`)
          }
        }
        if (parties.size > 1) {
          for (const row of group) issue(row, partyField, 'error', 'invoice_party_conflict', 'Invoice number yang sama tidak boleh digunakan untuk pihak berbeda')
        }
      }
    }

    const grouped = new Map<string, PreviewRowWrite[]>()
    for (const row of rows) {
      if (!row.documentKey) continue
      const group = grouped.get(row.documentKey) ?? []
      group.push(row)
      grouped.set(row.documentKey, group)
    }
    if (type === 'journal' || type === 'opening_balance') {
      for (const group of grouped.values()) {
        if (group.length < 2) {
          for (const row of group) issue(row, null, 'error', 'minimum_lines', 'Dokumen jurnal minimal memiliki dua baris')
          continue
        }
        const debit = sumScaled(group.map((row) => String(row.data.debit ?? 0)))
        const credit = sumScaled(group.map((row) => String(row.data.credit ?? 0)))
        if (debit !== credit || debit <= 0n) {
          for (const row of group) issue(row, null, 'error', 'unbalanced_document', 'Total debit dan kredit dokumen tidak balance')
        }
      }
    }
    if (type === 'inventory') {
      for (const group of grouped.values()) {
        if (group.length > 1) {
          for (const row of group) issue(row, null, 'error', 'duplicate_inventory_opening', 'Item dan gudang duplikat di dalam file')
        }
      }
    }
    if (type === 'bank_statement') {
      for (const group of grouped.values()) {
        const accountValues = new Set(group.map((row) => normalizedCode(row.data.bank_account_code)))
        if (accountValues.size > 1) {
          for (const row of group) issue(row, 'bank_account_code', 'error', 'statement_account_conflict', 'Satu statement hanya boleh untuk satu rekening bank')
        }
        if (!group.length || group.some((row) => row.issues.some((item) => item.severity === 'error'))) continue
        const first = group[0]!.data
        const debitOpening = subtractDecimal(
          addDecimal([String(first.balance), String(first.credit)]),
          String(first.debit),
        )
        const creditOpening = subtractDecimal(
          addDecimal([String(first.balance), String(first.debit)]),
          String(first.credit),
        )
        const follows = (opening: string, debitIncreases: boolean) => {
          let running = opening
          for (const row of group) {
            running = debitIncreases
              ? subtractDecimal(
                  addDecimal([running, String(row.data.debit)]),
                  String(row.data.credit),
                )
              : subtractDecimal(
                  addDecimal([running, String(row.data.credit)]),
                  String(row.data.debit),
                )
            if (compareDecimal(running, String(row.data.balance)) !== 0) return false
          }
          return true
        }
        if (!follows(debitOpening, true) && !follows(creditOpening, false)) {
          for (const row of group) {
            issue(row, 'balance', 'error', 'running_balance_mismatch', 'Saldo berjalan tidak konsisten dengan debit dan kredit')
          }
        }
      }
    }
  }

  private validateAccountHierarchy(rows: PreviewRowWrite[], catalog: ReferenceCatalog) {
    const byCode = new Map(rows.map((row) => [normalizedCode(row.data.account_code), row]))

    for (const row of rows) {
      const ownCode = normalizedCode(row.data.account_code)
      let parentCode = normalizedCode(row.data.parent_code)
      const visited = new Set(ownCode ? [ownCode] : [])

      while (parentCode && !catalog.accounts.has(parentCode)) {
        if (visited.has(parentCode)) {
          issue(
            row,
            'parent_code',
            'error',
            'account_hierarchy_cycle',
            'Hierarki akun mengandung siklus',
          )
          break
        }
        visited.add(parentCode)

        const parent = byCode.get(parentCode)
        if (!parent) break
        if (parent.issues.some((item) => item.code === 'account_hierarchy_cycle')) {
          issue(
            row,
            'parent_code',
            'error',
            'account_hierarchy_cycle',
            'Hierarki akun mengandung siklus',
          )
          break
        }
        if (parent.issues.some((item) => item.severity === 'error')) {
          issue(
            row,
            'parent_code',
            'error',
            'invalid_parent_account',
            'Akun induk di dalam file tidak valid dan tidak dapat dibuat',
          )
          break
        }
        parentCode = normalizedCode(parent.data.parent_code)
      }
    }
  }

  private async validateDatabaseDuplicates(
    connection: QueryExecutor,
    companyId: number,
    type: ImportType,
    rows: PreviewRowWrite[],
  ) {
    if (type === 'customer' || type === 'supplier' || type === 'item' || type === 'chart_of_accounts') {
      const catalog = await loadReferenceCatalog(companyId, connection)
      const map = type === 'customer' ? catalog.customers : type === 'supplier' ? catalog.suppliers : type === 'item' ? catalog.items : catalog.accounts
      for (const row of rows) {
        if (row.documentKey && map.has(row.documentKey)) {
          row.isDuplicate = true
          issue(row, null, 'warning', 'duplicate_existing', 'Data sudah ada dan akan dilewati; data existing tidak ditimpa')
        }
      }
      return
    }
    const existing = await existingTransactionKeys(connection, companyId, type, rows)
    for (const row of rows) {
      if (!row.documentKey) continue
      if (existing.has(row.documentKey)) {
        row.isDuplicate = true
        issue(row, null, 'warning', 'duplicate_existing', 'Transaksi sudah ada dan akan dilewati')
      } else if ((type === 'sales' || type === 'purchase') && existing.has(`reference:${normalizedCode(row.reference)}`)) {
        issue(row, 'invoice_number', 'error', 'invoice_number_conflict', 'Invoice number sudah digunakan oleh pihak lain')
      }
    }
  }

  private async validateExistingInventory(
    connection: QueryExecutor,
    companyId: number,
    rows: PreviewRowWrite[],
    catalog: ReferenceCatalog,
  ) {
    for (const row of rows) {
      const item = catalog.items.get(normalizedCode(row.data.item_code))
      const warehouse = catalog.warehouses.get(normalizedCode(row.data.warehouse))
      if (!item || !warehouse) continue
      const [found] = await connection.execute<RowDataPacket[]>(
        `SELECT 1 FROM inventory_movements
         WHERE company_id = ? AND item_id = ? AND warehouse_id = ? LIMIT 1`,
        [companyId, Number(item.id), Number(warehouse.id)],
      )
      if (found[0]) issue(row, null, 'error', 'inventory_already_started', 'Opening stock tidak dapat diimpor karena item/gudang sudah memiliki pergerakan')
    }
  }

  private propagateDocumentErrors(type: ImportType, rows: PreviewRowWrite[]) {
    if (!['sales', 'purchase', 'journal', 'opening_balance', 'bank_statement'].includes(type)) return
    const groups = new Map<string, PreviewRowWrite[]>()
    for (const row of rows) {
      if (!row.documentKey) continue
      const group = groups.get(row.documentKey) ?? []
      group.push(row)
      groups.set(row.documentKey, group)
    }
    for (const group of groups.values()) {
      if (!group.some((row) => row.issues.some((item) => item.severity === 'error'))) continue
      for (const row of group) {
        if (!row.issues.some((item) => item.severity === 'error')) {
          issue(row, null, 'error', 'document_has_invalid_row', 'Dokumen tidak dapat diimpor karena baris lain tidak valid')
        }
      }
    }
  }
}
