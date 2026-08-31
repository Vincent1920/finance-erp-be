import { InvoiceRepository, type SalesInvoiceWrite } from '../repositories/InvoiceRepository'
import type { QueryExecutor } from '../types/database'
import { transaction } from '../config/database'
import { ConflictError, NotFoundError, ValidationError } from '../utils/AppError'
import { addDecimal, compareDecimal } from '../utils/decimal'
import type { SalesInvoiceInput, SalesInvoiceUpdateInput } from '../validators/sales-invoice.validator'
import { AuditService } from './AuditService'
import { BusinessValidationService } from './BusinessValidationService'
import { InventoryCostingService } from './InventoryCostingService'
import {
  duplicateInvoiceError,
  importedSalesInvoiceSchema,
  importedStatus,
  prepareImportedInvoice,
  type CreatedImportedInvoice,
  type ImportedSalesInvoiceInput,
  type InvoiceMutationContext,
} from './InvoiceDomainSupport'
import { NumberSequenceService } from './NumberSequenceService'
import { PostingService, type JournalLineInput } from './PostingService'

export type {
  CreatedImportedInvoice,
  ImportedSalesInvoiceInput,
  InvoiceMutationContext,
} from './InvoiceDomainSupport'

export class SalesInvoiceService {
  constructor(
    private repository = new InvoiceRepository(),
    private validation = new BusinessValidationService(),
    private audit = new AuditService(),
    private sequences = new NumberSequenceService(),
    private posting = new PostingService(),
    private inventory = new InventoryCostingService(),
  ) {}

  list(companyId: number, query: Parameters<InvoiceRepository['listSales']>[1]) {
    return this.repository.listSales(companyId, query)
  }

  async get(id: number, companyId: number) {
    const invoice = await this.repository.salesDetail(id, companyId)
    if (!invoice) throw new NotFoundError('Sales invoice tidak ditemukan')
    return invoice
  }

  async create(companyId: number, input: SalesInvoiceInput, context: InvoiceMutationContext) {
    return transaction(async (connection) => {
      const invoiceNumber = await this.sequences.next(connection, companyId, 'sales_invoice', input.invoice_date)
      const write = await this.prepare(connection, companyId, invoiceNumber, input, context.userId)
      const id = await this.repository.insertSales(connection, write)
      await this.log(connection, companyId, context, 'create', id, invoiceNumber, { status: 'draft', grandTotal: write.totals.grandTotal })
      return { id, invoiceNumber, status: 'draft' as const }
    })
  }

  async update(id: number, companyId: number, input: SalesInvoiceUpdateInput, context: InvoiceMutationContext) {
    return transaction(async (connection) => {
      const current = await this.repository.findSales(connection, id, companyId, true)
      if (!current) throw new NotFoundError('Sales invoice tidak ditemukan')
      if (current.sales_order_id) throw new ConflictError('Invoice hasil konversi sales order tidak dapat diedit langsung')
      if (!['draft', 'rejected'].includes(String(current.status))) throw new ConflictError('Hanya invoice Draft atau Rejected yang dapat diedit')
      const write = await this.prepare(connection, companyId, String(current.invoice_number), input, context.userId)
      if (!(await this.repository.updateSales(connection, id, input.version, write))) throw new ConflictError('Sales invoice telah berubah; muat ulang sebelum menyimpan')
      await this.log(connection, companyId, context, 'update', id, String(current.invoice_number), { status: 'draft', version: input.version + 1 })
      return { id, version: input.version + 1 }
    })
  }

  submit(id: number, companyId: number, context: InvoiceMutationContext) {
    return this.transition(id, companyId, ['draft', 'rejected'], "status='pending_approval', approval_status='pending', submitted_by=?, submitted_at=NOW()", [context.userId], 'submit', context)
  }

  approve(id: number, companyId: number, context: InvoiceMutationContext) {
    return this.transition(id, companyId, ['pending_approval'], "status='approved', approval_status='approved', approved_by=?, approved_at=NOW()", [context.userId], 'approve', context)
  }

  reject(id: number, companyId: number, reason: string, context: InvoiceMutationContext) {
    return this.transition(id, companyId, ['pending_approval'], "status='rejected', approval_status='rejected', rejected_by=?, rejected_at=NOW(), rejection_reason=?", [context.userId, reason], 'reject', context)
  }

  async cancel(id: number, companyId: number, reason: string, context: InvoiceMutationContext) {
    return transaction(async (connection) => {
      const invoice = await this.repository.findSales(connection, id, companyId, true)
      if (!invoice) throw new NotFoundError('Sales invoice tidak ditemukan')
      if (!['draft', 'rejected'].includes(String(invoice.status))) throw new ConflictError('Hanya invoice Draft atau Rejected yang dapat dibatalkan')
      if (invoice.sales_order_id) await this.repository.releaseSalesOrderInvoice(connection, id, Number(invoice.sales_order_id))
      if (!(await this.repository.transitionSales(connection,id,companyId,['draft','rejected'],"status='cancelled', cancelled_by=?, cancelled_at=NOW(), cancellation_reason=?",[context.userId,reason]))) throw new ConflictError('Status sales invoice telah berubah')
      await this.log(connection, companyId, context, 'cancel', id, String(invoice.invoice_number), { status: 'cancelled', reason })
      return { id, status: 'cancelled' as const }
    })
  }

  async post(id: number, companyId: number, context: InvoiceMutationContext) {
    return transaction(async (connection) => {
      const invoice = await this.repository.findSales(connection, id, companyId, true)
      if (!invoice) throw new NotFoundError('Sales invoice tidak ditemukan')
      if (invoice.status !== 'approved') throw new ConflictError('Hanya sales invoice Approved yang dapat diposting')
      if (!invoice.receivable_account_id) throw new ValidationError('Akun piutang pelanggan belum dikonfigurasi')
      const lines = await this.repository.salesLines(connection, id)
      const journals: JournalLineInput[] = [{ accountId: Number(invoice.receivable_account_id), description: String(invoice.invoice_number), debit: String(invoice.base_grand_total), credit: '0' }]
      const credits = new Map<number, string>()
      const debits = new Map<number, string>()
      const movementIds: number[] = []
      for (const line of lines) {
        this.addAccount(credits, Number(line.revenue_account_id), String(line.base_subtotal), 'Akun pendapatan belum dikonfigurasi')
        if (compareDecimal(String(line.base_tax_amount), '0') > 0) this.addAccount(credits, Number(line.output_tax_account_id), String(line.base_tax_amount), 'Akun pajak keluaran belum dikonfigurasi')
        if (line.item_type === 'inventory') {
          if (!invoice.warehouse_id) throw new ValidationError('Gudang wajib diisi untuk invoice barang inventory')
          if (!line.inventory_account_id || !line.purchase_account_id) throw new ValidationError(`Akun persediaan/COGS item ${line.item_code} belum dikonfigurasi`)
          const movement = await this.inventory.applyMovement(connection, { companyId, itemId: Number(line.item_id), warehouseId: Number(invoice.warehouse_id), direction: 'out', quantity: String(line.quantity), transactionType: 'sales_invoice', transactionId: id, sourceLineId: Number(line.id), transactionNumber: String(invoice.invoice_number), movementDate: this.date(invoice.invoice_date), reference: invoice.reference ? String(invoice.reference) : null, postingKey: `sales-invoice:${id}:line:${line.id}`, userId: context.userId })
          movementIds.push(movement.movementId)
          this.addAccount(debits, Number(line.purchase_account_id), movement.totalCost, 'Akun COGS belum dikonfigurasi')
          this.addAccount(credits, Number(line.inventory_account_id), movement.totalCost, 'Akun persediaan belum dikonfigurasi')
          await connection.execute('UPDATE sales_invoice_lines SET cogs_amount=? WHERE id=?', [movement.totalCost, line.id])
        }
      }
      for (const [accountId, amount] of debits) journals.push({ accountId, description: `COGS ${invoice.invoice_number}`, debit: amount, credit: '0' })
      for (const [accountId, amount] of credits) journals.push({ accountId, description: String(invoice.invoice_number), debit: '0', credit: amount })
      const journalId = await this.posting.createPostedJournal(connection, { companyId, sourceType: 'sales_invoice', sourceId: id, date: this.date(invoice.invoice_date), reference: String(invoice.invoice_number), description: `Sales invoice ${invoice.invoice_number} - ${invoice.customer_name}`, currency: String(invoice.currency), exchangeRate: String(invoice.exchange_rate), lines: journals, context })
      if (movementIds.length) await connection.execute(`UPDATE inventory_movements SET journal_id=? WHERE id IN (${movementIds.map(() => '?').join(',')})`, [journalId, ...movementIds])
      if (!(await this.repository.transitionSales(connection,id,companyId,['approved'],"status='posted', journal_id=?, posted_by=?, posted_at=NOW()",[journalId,context.userId]))) throw new ConflictError('Status sales invoice telah berubah')
      await this.log(connection, companyId, context, 'post', id, String(invoice.invoice_number), { status: 'posted', journalId })
      return { id, status: 'posted' as const, journalId }
    })
  }

  async reverse(id: number, companyId: number, date: string, reason: string, context: InvoiceMutationContext) {
    return transaction(async (connection) => {
      const invoice = await this.repository.findSales(connection, id, companyId, true)
      if (!invoice) throw new NotFoundError('Sales invoice tidak ditemukan')
      if (invoice.status !== 'posted') throw new ConflictError('Hanya sales invoice Posted yang dapat direversal')
      if (compareDecimal(String(invoice.paid_amount), '0') > 0) throw new ConflictError('Invoice yang sudah menerima pembayaran tidak dapat direversal')
      const reversalJournalId = await this.posting.reversePostedJournal(connection, { companyId, journalId: Number(invoice.journal_id), date, reason, context, sourceType: 'sales_invoice_reversal', sourceId: id })
      const reversalMovementIds: number[] = []
      for (const movement of await this.repository.salesMovements(connection, companyId, id)) {
        const reversed = await this.inventory.reverseMovement(connection, { companyId, movementId: Number(movement.id), movementDate: date, transactionType: 'sales_invoice_reversal', transactionId: id, transactionNumber: String(invoice.invoice_number), userId: context.userId, reference: reason })
        reversalMovementIds.push(reversed.movementId)
      }
      if (reversalMovementIds.length) await connection.execute(`UPDATE inventory_movements SET journal_id=? WHERE id IN (${reversalMovementIds.map(() => '?').join(',')})`, [reversalJournalId, ...reversalMovementIds])
      if (invoice.sales_order_id) await this.repository.releaseSalesOrderInvoice(connection, id, Number(invoice.sales_order_id))
      if (!(await this.repository.transitionSales(connection,id,companyId,['posted'],"status='reversed', reversal_journal_id=?, reversed_by=?, reversed_at=NOW()",[reversalJournalId,context.userId]))) throw new ConflictError('Status sales invoice telah berubah')
      await this.log(connection, companyId, context, 'reverse', id, String(invoice.invoice_number), { status: 'reversed', reversalJournalId, reason })
      return { id, status: 'reversed' as const, reversalJournalId }
    })
  }

  /**
   * Creates one fully grouped imported sales invoice on the caller-owned transaction.
   * This operation never posts a journal or changes inventory.
   */
  async createImported(
    connection: QueryExecutor,
    companyId: number,
    input: ImportedSalesInvoiceInput,
    context: InvoiceMutationContext,
  ): Promise<CreatedImportedInvoice> {
    if (!Number.isSafeInteger(companyId) || companyId <= 0) {
      throw new ValidationError('Company invoice tidak valid')
    }
    if (!Number.isSafeInteger(context.userId) || context.userId <= 0) {
      throw new ValidationError('User pembuat invoice tidak valid')
    }

    const parsed = importedSalesInvoiceSchema.parse(input)
    const duplicate = await this.repository.findSalesDuplicate(
      connection,
      companyId,
      parsed.invoiceNumber,
    )
    if (duplicate) throw duplicateInvoiceError('sales', parsed.invoiceNumber)

    const prepared = await prepareImportedInvoice(
      connection,
      companyId,
      'sales',
      {
        invoiceNumber: parsed.invoiceNumber,
        invoiceDate: parsed.invoiceDate,
        dueDate: parsed.dueDate,
        partyId: parsed.customerId,
        warehouseId: parsed.warehouseId,
        currency: parsed.currency,
        exchangeRate: parsed.exchangeRate,
        lines: parsed.lines.map(({ revenueAccountId, ...line }) => ({
          ...line,
          accountId: revenueAccountId,
        })),
      },
      this.repository,
      this.validation,
    )
    const status = importedStatus(parsed.importAs)
    const id = await this.repository.insertSales(connection, {
      companyId,
      invoiceNumber: parsed.invoiceNumber,
      invoiceDate: parsed.invoiceDate,
      dueDate: parsed.dueDate,
      customerId: parsed.customerId,
      warehouseId: prepared.warehouseId,
      reference: parsed.reference,
      notes: parsed.notes,
      currency: parsed.currency,
      exchangeRate: parsed.exchangeRate,
      status,
      accountingPeriodId: prepared.accountingPeriodId,
      userId: context.userId,
      totals: prepared.totals,
      lines: prepared.lines,
    })

    await this.audit.log(connection, {
      companyId,
      userId: context.userId,
      module: 'sales-invoices',
      action: 'create_imported',
      recordType: 'sales_invoice',
      recordId: id,
      recordNumber: parsed.invoiceNumber,
      newValue: {
        status,
        customerId: parsed.customerId,
        invoiceDate: parsed.invoiceDate,
        grandTotal: prepared.totals.grandTotal,
      },
      requestId: context.requestId,
      ip: context.ip,
      metadata: { source: context.source ?? 'data_import', lineCount: prepared.lines.length },
    })

    return { id, invoiceNumber: parsed.invoiceNumber, status, totals: prepared.totals }
  }

  private async prepare(connection: QueryExecutor, companyId: number, invoiceNumber: string, input: SalesInvoiceInput, userId: number): Promise<SalesInvoiceWrite> {
    const prepared = await prepareImportedInvoice(connection, companyId, 'sales', {
      invoiceNumber, invoiceDate: input.invoice_date, dueDate: input.due_date,
      partyId: input.customer_id, warehouseId: input.warehouse_id ?? null,
      currency: input.currency, exchangeRate: input.exchange_rate,
      lines: input.lines.map((line) => ({ itemId: line.item_id, description: line.description ?? null, quantity: line.quantity, unitId: line.unit_id ?? null, unitPrice: line.unit_price, discount: line.discount, discountPercent: line.discount_percent, taxCodeId: line.tax_code_id ?? null, accountId: line.revenue_account_id ?? null })),
    }, this.repository, this.validation)
    return { companyId, invoiceNumber, invoiceDate: input.invoice_date, dueDate: input.due_date, customerId: input.customer_id, warehouseId: prepared.warehouseId, reference: input.reference ?? null, notes: input.notes ?? null, currency: input.currency, exchangeRate: input.exchange_rate, status: 'draft', accountingPeriodId: prepared.accountingPeriodId, userId, totals: prepared.totals, lines: prepared.lines }
  }

  private async transition(id: number, companyId: number, from: string[], fields: string, values: Array<string | number | Date | null>, action: string, context: InvoiceMutationContext) {
    return transaction(async (connection) => {
      const invoice = await this.repository.findSales(connection, id, companyId, true)
      if (!invoice) throw new NotFoundError('Sales invoice tidak ditemukan')
      if (!from.includes(String(invoice.status))) throw new ConflictError(`Sales invoice ${invoice.status} tidak dapat diproses`)
      if (!(await this.repository.transitionSales(connection, id, companyId, from, fields, values))) throw new ConflictError('Status sales invoice telah berubah')
      const status = action === 'submit' ? 'pending_approval' : action === 'approve' ? 'approved' : 'rejected'
      await this.log(connection, companyId, context, action, id, String(invoice.invoice_number), { status })
      return { id, status }
    })
  }

  private addAccount(map: Map<number, string>, accountId: number, amount: string, message: string) {
    if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new ValidationError(message)
    map.set(accountId, addDecimal([map.get(accountId) ?? '0', amount]))
  }

  private date(value: Date | string) { return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10) }

  private async log(connection: QueryExecutor, companyId: number, context: InvoiceMutationContext, action: string, id: number, number: string, newValue: Record<string, unknown>) {
    await this.audit.log(connection, { companyId, userId: context.userId, module: 'sales-invoices', action, recordType: 'sales_invoice', recordId: id, recordNumber: number, newValue, requestId: context.requestId, ip: context.ip })
  }
}
