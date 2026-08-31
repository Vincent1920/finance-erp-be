import { createHash, randomUUID } from 'node:crypto'
import type { QueryExecutor } from '../types/database'

import { db, transaction } from '../config/database'
import {
  ImportRepository,
  mapImportJob,
  type PreviewRowWrite,
} from '../repositories/ImportRepository'
import {
  accountSchema,
  customerSchema,
  itemSchema,
  supplierSchema,
} from '../validators/entity.validator'
import { journalSchema } from '../validators/journal.validator'
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../utils/AppError'
import { addDecimal, compareDecimal, subtractDecimal } from '../utils/decimal'
import { AuditService } from './AuditService'
import { BankStatementService } from './BankStatementService'
import { EntityService, type MutationContext } from './EntityService'
import { JournalService } from './JournalService'
import { OpeningBalanceService } from './OpeningBalanceService'
import { PurchaseInvoiceService } from './PurchaseInvoiceService'
import { SalesInvoiceService } from './SalesInvoiceService'
import {
  IMPORT_DEFINITIONS,
  IMPORT_TYPES,
  getImportDefinition,
  type ImportAs,
  type ImportType,
} from './import/ImportDefinitions'
import {
  MAX_IMPORT_FILE_SIZE,
  MAX_IMPORT_ROWS,
  createErrorReport,
  createImportTemplate,
  parseImportFile,
  type ImportFileLike,
  type ParsedImportRow,
} from './import/TabularFileService'
import {
  ImportValidationService,
  loadReferenceCatalog,
  type ReferenceCatalog,
  type ReferenceRow,
} from './import/ImportValidationService'
import type { ImportConfirmInput } from '../validators/import.validator'

export interface ImportActor extends MutationContext {
  id: number
  companyId: number
  roles: string[]
  permissions: string[]
}

type StagedRow = Awaited<ReturnType<ImportRepository['allRows']>>[number]

const code = (value: unknown) => String(value ?? '').trim().toUpperCase()
const text = (value: unknown) => (value === null || value === undefined ? null : String(value))
const idOf = (row: Record<string, unknown> | undefined, label: string) => {
  const id = Number(row?.id)
  if (!Number.isSafeInteger(id) || id <= 0) throw new ValidationError(`${label} tidak ditemukan`)
  return id
}
const groupRows = (rows: StagedRow[]) => {
  const groups = new Map<string, StagedRow[]>()
  for (const row of rows) {
    const key = row.documentKey ?? `row:${row.rowNumber}`
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }
  return [...groups.values()]
}
const safeBatchNumber = (importNumber: string, suffix: string) =>
  `${importNumber}-${suffix}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 50)

export class ImportService {
  constructor(
    private readonly repository = new ImportRepository(),
    private readonly validation = new ImportValidationService(),
    private readonly audit = new AuditService(),
    private readonly sales = new SalesInvoiceService(),
    private readonly purchases = new PurchaseInvoiceService(),
    private readonly journals = new JournalService(),
    private readonly openingBalances = new OpeningBalanceService(),
    private readonly bankStatements = new BankStatementService(),
  ) {}

  async config(actor: ImportActor) {
    await this.repository.cleanupExpired()
    return this.allowedTypes(actor).map((type) => {
      const definition = getImportDefinition(type)
      return {
        ...definition,
        maxFileSize: MAX_IMPORT_FILE_SIZE,
        maxRows: MAX_IMPORT_ROWS,
      }
    })
  }

  async list(
    actor: ImportActor,
    query: { page: number; limit: number; type?: ImportType; status?: Parameters<ImportRepository['list']>[1]['status'] },
  ) {
    const allowedTypes = this.allowedTypes(actor)
    if (!allowedTypes.length) throw new ForbiddenError()
    if (query.type) this.assertPermission(actor, query.type)
    return this.repository.list(actor.companyId, { ...query, allowedTypes })
  }

  async get(actor: ImportActor, id: number) {
    const job = await this.ownedJob(actor, id)
    return mapImportJob(job)
  }

  async rows(
    actor: ImportActor,
    id: number,
    query: { page: number; limit: number; status?: 'valid' | 'warning' | 'error' },
  ) {
    await this.ownedJob(actor, id)
    return this.repository.rows(id, query)
  }

  template(actor: ImportActor, type: ImportType, format: 'csv' | 'xlsx') {
    this.assertPermission(actor, type)
    return createImportTemplate(type, format)
  }

  async preview(actor: ImportActor, type: ImportType, file: ImportFileLike) {
    this.assertPermission(actor, type)
    const { parsed, buffer } = await parseImportFile(file, type)
    const checksum = createHash('sha256').update(buffer).digest('hex')
    const fileName = file.name.replace(/[\\/\u0000-\u001F]/g, '_').slice(0, 255)
    const importNumber = `IMP-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8).toUpperCase()}`
    const id = await this.repository.createJob({
      companyId: actor.companyId,
      importNumber,
      type,
      fileName,
      checksum,
      requestedBy: actor.id,
    })

    try {
      const preview = await this.validation.validate(actor.companyId, type, parsed.rows)
      await transaction((connection) =>
        this.repository.savePreview(connection, id, preview.rows, {
          ...preview.summary,
          warnings: parsed.warnings,
        }),
      )
      const job = await this.repository.find(id, actor.companyId, actor.id)
      if (!job) throw new NotFoundError('Import job tidak ditemukan')
      const page = await this.repository.rows(id, { page: 1, limit: 50 })
      return { job: mapImportJob(job), rows: page.rows, meta: page }
    } catch (error) {
      await this.repository.markFailed(id, this.safeError(error))
      throw error
    }
  }

  async confirm(actor: ImportActor, id: number, options: ImportConfirmInput) {
    const existing = await this.ownedJob(actor, id)
    const definition = getImportDefinition(existing.entity_type)
    if (!definition.supportsImportAs && options.import_as !== 'draft') {
      throw new ValidationError('Jenis import ini tidak mendukung status Submitted')
    }

    const staged = await this.repository.allRows(id)
    if (!staged.length) throw new ConflictError('Payload preview sudah tidak tersedia atau kedaluwarsa')
    const refreshed = await this.validation.validate(
      actor.companyId,
      existing.entity_type,
      staged.map((row) => ({ rowNumber: row.rowNumber, data: row.data })),
    )
    await transaction((connection) =>
      this.repository.savePreview(connection, id, refreshed.rows, {
        ...refreshed.summary,
        warnings: [],
      }),
    )
    if (options.error_policy === 'all_or_nothing' && refreshed.summary.errorRows > 0) {
      throw new ConflictError('Import dibatalkan karena masih terdapat error kritis')
    }

    try {
      await transaction(async (connection) => {
        const locked = await this.repository.find(id, actor.companyId, actor.id, connection, true)
        if (!locked) throw new NotFoundError('Import job tidak ditemukan')
        if (!['ready', 'validation_failed'].includes(locked.status)) {
          throw new ConflictError(`Import berstatus ${locked.status} tidak dapat dikonfirmasi`)
        }
        if (locked.expires_at && new Date(locked.expires_at).getTime() < Date.now()) {
          throw new ConflictError('Preview import sudah kedaluwarsa; unggah ulang file')
        }

        const currentRows = await this.repository.allRows(id, connection)
        const revalidated = await this.validation.validate(
          actor.companyId,
          locked.entity_type,
          currentRows.map((row) => ({ rowNumber: row.rowNumber, data: row.data })),
          connection,
        )
        if (options.error_policy === 'all_or_nothing' && revalidated.summary.errorRows > 0) {
          throw new ConflictError('Data berubah setelah preview dan sekarang memiliki error kritis')
        }
        const eligible = revalidated.rows.filter(
          (row) =>
            !row.issues.some((item) => item.severity === 'error') &&
            !(options.skip_duplicates && row.isDuplicate),
        ) as StagedRow[]

        await connection.execute(
          `UPDATE import_jobs
           SET status = 'importing', import_as = ?, error_policy = ?, skip_duplicates = ?
           WHERE id = ?`,
          [definition.supportsImportAs ? options.import_as : null, options.error_policy, true, id],
        )

        const catalog = await loadReferenceCatalog(actor.companyId, connection)
        await this.importRows(
          connection,
          locked.entity_type,
          eligible,
          catalog,
          actor,
          definition.supportsImportAs ? options.import_as : 'draft',
          locked.import_number,
          locked.file_name,
          locked.checksum,
        )

        const importedRows = eligible.length
        const failedRows = revalidated.rows.length - importedRows
        const finalStatus = failedRows > 0 ? 'completed_with_errors' : 'completed'
        await this.audit.log(connection, {
          companyId: actor.companyId,
          userId: actor.id,
          module: 'imports',
          action: 'import',
          recordType: 'import_job',
          recordId: id,
          recordNumber: locked.import_number,
          newValue: {
            importType: locked.entity_type,
            fileName: locked.file_name,
            totalRows: revalidated.rows.length,
            importedRows,
            failedRows,
            status: finalStatus,
          },
          metadata: { errorPolicy: options.error_policy, importAs: options.import_as },
          requestId: actor.requestId,
          ip: actor.ip,
        })
        await connection.execute(
          `UPDATE import_jobs
           SET status = ?, imported_rows = ?, failed_rows = ?, completed_at = NOW(), error_message = NULL
           WHERE id = ?`,
          [finalStatus, importedRows, failedRows, id],
        )
        if (failedRows === 0) {
          await connection.execute('DELETE FROM import_job_rows WHERE import_job_id = ?', [id])
          await connection.execute('DELETE FROM import_job_errors WHERE import_job_id = ?', [id])
          await connection.execute('UPDATE import_jobs SET payload_deleted_at = NOW() WHERE id = ?', [id])
        }
      })
    } catch (error) {
      if (!(error instanceof ConflictError && error.message.includes('error kritis'))) {
        await this.repository.markFailed(id, this.safeError(error))
      }
      throw error
    }

    const completed = await this.repository.find(id, actor.companyId, actor.id)
    if (!completed) throw new NotFoundError('Import job tidak ditemukan')
    return mapImportJob(completed)
  }

  async cancel(actor: ImportActor, id: number) {
    await this.ownedJob(actor, id)
    if (!(await this.repository.cancel(id, actor.companyId, actor.id))) {
      throw new ConflictError('Import tidak dapat dibatalkan pada status saat ini')
    }
    const job = await this.repository.find(id, actor.companyId, actor.id)
    if (!job) throw new NotFoundError('Import job tidak ditemukan')
    return mapImportJob(job)
  }

  async errorReport(actor: ImportActor, id: number, format: 'csv' | 'xlsx') {
    const job = await this.ownedJob(actor, id)
    const rows = await this.repository.errors(id)
    return createErrorReport(rows, format, job.import_number)
  }

  private async importRows(
    connection: QueryExecutor,
    type: ImportType,
    rows: StagedRow[],
    catalog: ReferenceCatalog,
    actor: ImportActor,
    importAs: ImportAs,
    importNumber: string,
    fileName: string,
    checksum: string,
  ) {
    if (type === 'customer' || type === 'supplier' || type === 'item') {
      await this.importMasterRows(connection, type, rows, catalog, actor, importNumber)
      return
    }
    if (type === 'chart_of_accounts') {
      await this.importAccounts(connection, rows, catalog, actor)
      return
    }
    if (type === 'opening_balance') {
      let sequence = 1
      for (const group of groupRows(rows)) {
        const first = group[0]!.data
        await this.openingBalances.createGeneralLedger(
          connection,
          {
            companyId: actor.companyId,
            batchNumber: safeBatchNumber(importNumber, `GL${sequence++}`),
            asOfDate: String(first.as_of_date),
            description: text(first.description) ?? `Import ${text(first.reference) ?? 'opening balance'}`,
            status: 'draft',
            lines: group.map((row, index) => ({
              lineNumber: index + 1,
              accountId: idOf(catalog.accounts.get(code(row.data.account_code)), 'Akun'),
              debit: String(row.data.debit),
              credit: String(row.data.credit),
              documentNumber: text(row.data.reference),
              documentDate: String(row.data.as_of_date),
              notes: text(row.data.description),
            })),
          },
          this.context(actor),
        )
      }
      return
    }
    if (type === 'inventory') {
      let sequence = 1
      for (const group of groupRows(rows)) {
        const first = group[0]!.data
        await this.openingBalances.createInventory(
          connection,
          {
            companyId: actor.companyId,
            batchNumber: safeBatchNumber(importNumber, `STK${sequence++}`),
            asOfDate: String(first.as_of_date),
            description: text(first.description) ?? 'Import saldo awal persediaan',
            status: 'validated',
            lines: group.map((row, index) => ({
              lineNumber: index + 1,
              itemId: idOf(catalog.items.get(code(row.data.item_code)), 'Item'),
              warehouseId: idOf(catalog.warehouses.get(code(row.data.warehouse)), 'Gudang'),
              quantity: String(row.data.quantity),
              unitCost: String(row.data.unit_cost),
              documentNumber: text(row.data.reference),
              notes: text(row.data.description),
            })),
          },
          this.context(actor),
        )
      }
      return
    }
    if (type === 'sales' || type === 'purchase') {
      for (const group of groupRows(rows)) {
        const first = group[0]!.data
        const warehouseId = first.warehouse
          ? idOf(catalog.warehouses.get(code(first.warehouse)), 'Gudang')
          : null
        if (type === 'sales') {
          const customer = catalog.customers.get(code(first.customer_code))
          await this.sales.createImported(
            connection,
            actor.companyId,
            {
              invoiceNumber: String(first.invoice_number),
              invoiceDate: String(first.transaction_date),
              dueDate: String(first.due_date),
              customerId: idOf(customer, 'Customer'),
              warehouseId,
              reference: importNumber,
              notes: text(first.description),
              currency: String(customer?.currency ?? 'IDR'),
              importAs,
              lines: group.map((row) => ({
                itemId: idOf(catalog.items.get(code(row.data.item_code)), 'Item'),
                description: text(row.data.description),
                quantity: String(row.data.quantity),
                unitPrice: String(row.data.unit_price),
                discount: String(row.data.discount ?? 0),
                taxCodeId: row.data.tax_code
                  ? idOf(catalog.taxes.get(code(row.data.tax_code)), 'Kode pajak')
                  : null,
              })),
            },
            this.context(actor),
          )
        } else {
          const supplier = catalog.suppliers.get(code(first.supplier_code))
          await this.purchases.createImported(
            connection,
            actor.companyId,
            {
              invoiceNumber: String(first.invoice_number),
              supplierInvoiceNumber: String(first.invoice_number),
              invoiceDate: String(first.transaction_date),
              dueDate: String(first.due_date),
              supplierId: idOf(supplier, 'Supplier'),
              warehouseId,
              reference: importNumber,
              notes: text(first.description),
              currency: String(supplier?.currency ?? 'IDR'),
              importAs,
              lines: group.map((row) => ({
                itemId: idOf(catalog.items.get(code(row.data.item_code)), 'Item'),
                description: text(row.data.description),
                quantity: String(row.data.quantity),
                unitPrice: String(row.data.unit_price),
                discount: String(row.data.discount ?? 0),
                taxCodeId: row.data.tax_code
                  ? idOf(catalog.taxes.get(code(row.data.tax_code)), 'Kode pajak')
                  : null,
              })),
            },
            this.context(actor),
          )
        }
      }
      return
    }
    if (type === 'journal') {
      for (const group of groupRows(rows)) {
        const first = group[0]!.data
        const input = journalSchema.parse({
          journal_date: first.journal_date,
          reference: first.reference,
          description: first.description,
          currency: 'IDR',
          exchange_rate: '1',
          lines: group.map((row) => ({
            accountId: idOf(catalog.accounts.get(code(row.data.account_code)), 'Akun'),
            description: text(row.data.description) ?? undefined,
            costCenterId: row.data.cost_center
              ? idOf(catalog.costCenters.get(code(row.data.cost_center)), 'Pusat biaya')
              : null,
            projectId: row.data.project
              ? idOf(catalog.projects.get(code(row.data.project)), 'Proyek')
              : null,
            debit: row.data.debit,
            credit: row.data.credit,
          })),
        })
        const created = await this.journals.createInTransaction(
          connection,
          actor.companyId,
          input,
          this.context(actor),
        )
        if (importAs === 'submitted') {
          await this.journals.submitInTransaction(
            connection,
            created.id,
            actor.companyId,
            this.context(actor),
          )
        }
      }
      return
    }
    if (type === 'bank_statement') {
      for (const group of groupRows(rows)) {
        const first = group[0]!.data
        const dates = group.map((row) => String(row.data.transaction_date)).sort()
        const openingBalance = this.bankOpeningBalance(group)
        await this.bankStatements.create(
          connection,
          {
            companyId: actor.companyId,
            bankAccountId: idOf(catalog.bankAccounts.get(code(first.bank_account_code)), 'Rekening bank'),
            statementNumber: String(first.statement_number),
            periodStart: dates[0]!,
            periodEnd: dates.at(-1)!,
            openingBalance,
            closingBalance: String(group.at(-1)!.data.balance),
            status: 'imported',
            balanceConvention: 'auto',
            fileName,
            checksum: `${checksum}:${code(first.statement_number)}`.slice(0, 128),
            lines: group.map((row, index) => ({
              lineNumber: index + 1,
              transactionDate: String(row.data.transaction_date),
              description: String(row.data.description),
              reference: text(row.data.reference),
              debit: String(row.data.debit),
              credit: String(row.data.credit),
              balance: String(row.data.balance),
              externalId: null,
            })),
          },
          this.context(actor),
        )
      }
    }
  }

  private async importMasterRows(
    connection: QueryExecutor,
    type: 'customer' | 'supplier' | 'item',
    rows: StagedRow[],
    catalog: ReferenceCatalog,
    actor: ImportActor,
    importNumber: string,
  ) {
    const service = new EntityService(type === 'item' ? 'items' : type === 'customer' ? 'customers' : 'suppliers')
    for (const row of rows) {
      const data = row.data
      if (type === 'customer') {
        const receivable = data.receivable_account_code
          ? catalog.accounts.get(code(data.receivable_account_code))
          : undefined
        const created = await service.createInTransaction(
          connection,
          actor.companyId,
          customerSchema.parse({
            code: data.customer_code,
            name: data.customer_name,
            email: data.email,
            phone: data.phone,
            address: data.address,
            city: data.city,
            tax_number: data.tax_number,
            payment_term_days: data.payment_term,
            currency: data.currency,
            credit_limit: data.credit_limit,
            receivable_account_id: receivable ? Number(receivable.id) : null,
            is_active: true,
          }),
          this.context(actor),
        )
        await this.createPartyOpening(connection, 'customer', row, Number(created?.id), catalog, actor, importNumber)
      } else if (type === 'supplier') {
        const payable = data.payable_account_code
          ? catalog.accounts.get(code(data.payable_account_code))
          : undefined
        const created = await service.createInTransaction(
          connection,
          actor.companyId,
          supplierSchema.parse({
            code: data.supplier_code,
            name: data.supplier_name,
            email: data.email,
            phone: data.phone,
            address: data.address,
            city: data.city,
            tax_number: data.tax_number,
            payment_term_days: data.payment_term,
            currency: data.currency,
            payable_account_id: payable ? Number(payable.id) : null,
            is_active: true,
          }),
          this.context(actor),
        )
        await this.createPartyOpening(connection, 'supplier', row, Number(created?.id), catalog, actor, importNumber)
      } else {
        const unit = catalog.units.get(code(data.unit))
        const accountId = (field: string) =>
          data[field] ? idOf(catalog.accounts.get(code(data[field])), 'Akun item') : null
        const created = await service.createInTransaction(
          connection,
          actor.companyId,
          itemSchema.parse({
            sku: data.item_code,
            name: data.item_name,
            item_type: data.item_type,
            unit_id: idOf(unit, 'Satuan'),
            description: data.description,
            barcode: data.barcode,
            sales_account_id: accountId('sales_account_code'),
            inventory_account_id: accountId('inventory_account_code'),
            cogs_account_id: accountId('cogs_account_code'),
            purchase_account_id: accountId('purchase_account_code'),
            sales_price: data.selling_price,
            purchase_price: data.purchase_price,
            average_cost: 0,
            minimum_stock: data.minimum_stock,
            is_active: true,
          }),
          this.context(actor),
        )
        if (compareDecimal(String(data.opening_stock ?? 0), '0', 4) > 0) {
          await this.openingBalances.createInventory(
            connection,
            {
              companyId: actor.companyId,
              batchNumber: safeBatchNumber(importNumber, `I${row.rowNumber}`),
              asOfDate: String(data.opening_stock_date),
              description: `Opening stock ${String(data.item_code)}`,
              status: 'validated',
              lines: [
                {
                  itemId: Number(created?.id),
                  warehouseId: idOf(catalog.warehouses.get(code(data.warehouse)), 'Gudang'),
                  quantity: String(data.opening_stock),
                  unitCost: String(data.purchase_price ?? 0),
                  documentNumber: importNumber,
                },
              ],
            },
            this.context(actor),
          )
        }
      }
    }
  }

  private async createPartyOpening(
    connection: QueryExecutor,
    type: 'customer' | 'supplier',
    row: StagedRow,
    partyId: number,
    catalog: ReferenceCatalog,
    actor: ImportActor,
    importNumber: string,
  ) {
    const balance = String(row.data.opening_balance ?? 0)
    if (compareDecimal(balance, '0') === 0) return
    const controlField = type === 'customer' ? 'receivable_account_code' : 'payable_account_code'
    const controlId = idOf(catalog.accounts.get(code(row.data[controlField])), 'Akun kontrol')
    const offsetId = idOf(
      catalog.accounts.get(code(row.data.opening_balance_offset_account_code)),
      'Akun lawan saldo awal',
    )
    const absolute = compareDecimal(balance, '0') >= 0 ? balance : subtractDecimal('0', balance)
    const positive = compareDecimal(balance, '0') >= 0
    const controlDebit = type === 'customer' ? positive : !positive
    await this.openingBalances.createGeneralLedger(
      connection,
      {
        companyId: actor.companyId,
        batchNumber: safeBatchNumber(importNumber, `${type === 'customer' ? 'C' : 'S'}${row.rowNumber}`),
        asOfDate: String(row.data.opening_balance_date),
        description: `Saldo awal ${type} ${String(row.reference)}`,
        balanceType: 'mixed',
        status: 'draft',
        lines: [
          {
            accountId: controlId,
            lineType: type === 'customer' ? 'receivable' : 'payable',
            customerId: type === 'customer' ? partyId : null,
            supplierId: type === 'supplier' ? partyId : null,
            debit: controlDebit ? absolute : '0',
            credit: controlDebit ? '0' : absolute,
            documentNumber: String(row.reference),
            notes: `Party ID ${partyId}`,
          },
          {
            accountId: offsetId,
            debit: controlDebit ? '0' : absolute,
            credit: controlDebit ? absolute : '0',
            documentNumber: String(row.reference),
          },
        ],
      },
      this.context(actor),
    )
  }

  private async importAccounts(
    connection: QueryExecutor,
    rows: StagedRow[],
    catalog: ReferenceCatalog,
    actor: ImportActor,
  ) {
    const service = new EntityService('accounts')
    const pending = [...rows]
    while (pending.length) {
      let progress = false
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const row = pending[index]!
        const parentCode = code(row.data.parent_code)
        const parent = parentCode ? catalog.accounts.get(parentCode) : undefined
        if (parentCode && !parent) continue
        const created = await service.createInTransaction(
          connection,
          actor.companyId,
          accountSchema.parse({
            code: row.data.account_code,
            name: row.data.account_name,
            account_type: row.data.account_type,
            normal_balance: row.data.normal_balance,
            parent_id: parent ? Number(parent.id) : null,
            level: parent ? Number(parent.level ?? 0) + 1 : 0,
            is_header: row.data.is_header,
            is_posting: row.data.is_posting,
            allow_manual_journal: row.data.allow_manual_journal,
            cash_flow_category: row.data.cash_flow_category,
            report_group: row.data.report_group,
            is_active: true,
          }),
          this.context(actor),
        )
        catalog.accounts.set(code(row.data.account_code), created as unknown as ReferenceRow)
        pending.splice(index, 1)
        progress = true
      }
      if (!progress) throw new ValidationError('Hierarki Chart of Accounts tidak dapat diselesaikan')
    }
  }

  private bankOpeningBalance(group: StagedRow[]) {
    const first = group[0]!.data
    const balance = String(first.balance)
    const debit = String(first.debit)
    const credit = String(first.credit)
    const debitConvention = subtractDecimal(addDecimal([balance, credit]), debit)
    let running = debitConvention
    let debitWorks = true
    for (const row of group) {
      running = subtractDecimal(addDecimal([running, String(row.data.debit)]), String(row.data.credit))
      if (compareDecimal(running, String(row.data.balance)) !== 0) debitWorks = false
    }
    if (debitWorks) return debitConvention
    return subtractDecimal(addDecimal([balance, debit]), credit)
  }

  private context(actor: ImportActor) {
    return { userId: actor.id, requestId: actor.requestId, ip: actor.ip }
  }

  private allowedTypes(actor: ImportActor) {
    if (actor.roles.includes('super-admin') || actor.permissions.includes('*')) return [...IMPORT_TYPES]
    return IMPORT_TYPES.filter((type) => actor.permissions.includes(IMPORT_DEFINITIONS[type].permission))
  }

  private assertPermission(actor: ImportActor, type: ImportType) {
    if (!this.allowedTypes(actor).includes(type)) throw new ForbiddenError()
  }

  private async ownedJob(actor: ImportActor, id: number) {
    const job = await this.repository.find(id, actor.companyId, actor.id)
    if (!job) throw new NotFoundError('Import job tidak ditemukan')
    this.assertPermission(actor, job.entity_type)
    return job
  }

  private safeError(error: unknown) {
    if (error instanceof AppError) return error.message
    return 'Import gagal diproses dan seluruh perubahan telah di-rollback'
  }
}
