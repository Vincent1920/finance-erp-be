import type { RowDataPacket } from 'mysql2/promise'
import { prepareDirectPosting } from './WorkflowPolicyService'
import { transaction } from '../config/database'
import { InvoiceRepository, type PurchaseInvoiceWrite } from '../repositories/InvoiceRepository'
import type { QueryExecutor } from '../types/database'
import { ConflictError, NotFoundError, ValidationError } from '../utils/AppError'
import {
  addDecimal,
  compareDecimal,
  divideDecimal,
  subtractDecimal,
  percentageOf,
  multiplyDecimal,
} from '../utils/decimal'
import type {
  PurchaseInvoiceInput,
  PurchaseInvoiceUpdateInput,
} from '../validators/purchase-invoice.validator'
import { AuditService } from './AuditService'
import { BusinessValidationService } from './BusinessValidationService'
import { InventoryCostingService } from './InventoryCostingService'
import { NumberSequenceService } from './NumberSequenceService'
import { PostingService, type JournalLineInput } from './PostingService'
import { AccountMappingService } from './AccountMappingService'
import {
  duplicateInvoiceError,
  importedPurchaseInvoiceSchema,
  importedStatus,
  prepareImportedInvoice,
  type CreatedImportedInvoice,
  type ImportedPurchaseInvoiceInput,
  type InvoiceMutationContext,
} from './InvoiceDomainSupport'

export type {
  CreatedImportedInvoice,
  ImportedPurchaseInvoiceInput,
  InvoiceMutationContext,
} from './InvoiceDomainSupport'

export class PurchaseInvoiceService {
  constructor(
    private repository = new InvoiceRepository(),
    private validation = new BusinessValidationService(),
    private audit = new AuditService(),
    private sequences = new NumberSequenceService(),
    private posting = new PostingService(),
    private inventory = new InventoryCostingService(),
    private mappings = new AccountMappingService(),
  ) {}

  list(companyId: number, query: Parameters<InvoiceRepository['listPurchase']>[1]) {
    return this.repository.listPurchase(companyId, query)
  }

  async get(id: number, companyId: number) {
    const invoice = await this.repository.purchaseDetail(id, companyId)
    if (!invoice) throw new NotFoundError('Purchase invoice tidak ditemukan')
    return invoice
  }

  async create(companyId: number, input: PurchaseInvoiceInput, context: InvoiceMutationContext) {
    return transaction(async (connection) => {
      const invoiceNumber = await this.sequences.next(
        connection,
        companyId,
        'purchase_invoice',
        input.invoice_date,
      )
      const write = await this.prepare(connection, companyId, invoiceNumber, input, context.userId)
      const duplicate = await this.repository.findPurchaseDuplicate(
        connection,
        companyId,
        invoiceNumber,
        input.supplier_id,
        input.supplier_invoice_number,
      )
      if (duplicate) throw duplicateInvoiceError('purchase', input.supplier_invoice_number)
      const id = await this.repository.insertPurchase(connection, write)
      await this.applyWithholding(connection, companyId, id, input)
      await this.log(connection, companyId, context, 'create', id, invoiceNumber, {
        status: 'draft',
        grandTotal: write.totals.grandTotal,
      })
      return { id, invoiceNumber, status: 'draft' as const }
    })
  }

  async update(
    id: number,
    companyId: number,
    input: PurchaseInvoiceUpdateInput,
    context: InvoiceMutationContext,
  ) {
    return transaction(async (connection) => {
      const current = await this.repository.findPurchase(connection, id, companyId, true)
      if (!current) throw new NotFoundError('Purchase invoice tidak ditemukan')
      if (current.purchase_order_id || current.goods_receipt_id)
        throw new ConflictError('Invoice hasil PO atau penerimaan tidak dapat diedit langsung')
      if (!['draft', 'rejected'].includes(String(current.status)))
        throw new ConflictError('Hanya invoice Draft atau Rejected yang dapat diedit')
      const duplicate = await this.repository.findPurchaseDuplicate(
        connection,
        companyId,
        String(current.invoice_number),
        input.supplier_id,
        input.supplier_invoice_number,
      )
      if (duplicate && Number(duplicate.id) !== id)
        throw duplicateInvoiceError('purchase', input.supplier_invoice_number)
      const write = await this.prepare(
        connection,
        companyId,
        String(current.invoice_number),
        input,
        context.userId,
      )
      if (!(await this.repository.updatePurchase(connection, id, input.version, write)))
        throw new ConflictError('Purchase invoice telah berubah; muat ulang sebelum menyimpan')
      await this.applyWithholding(connection, companyId, id, input)
      await this.log(connection, companyId, context, 'update', id, String(current.invoice_number), {
        status: 'draft',
        version: input.version + 1,
      })
      return { id, version: input.version + 1 }
    })
  }

  submit(id: number, companyId: number, context: InvoiceMutationContext) {
    return this.transition(
      id,
      companyId,
      ['draft', 'rejected'],
      "status='pending_approval', approval_status='pending', submitted_by=?, submitted_at=NOW()",
      [context.userId],
      'submit',
      context,
    )
  }
  approve(id: number, companyId: number, context: InvoiceMutationContext) {
    return this.transition(
      id,
      companyId,
      ['pending_approval'],
      "status='approved', approval_status='approved', approved_by=?, approved_at=NOW()",
      [context.userId],
      'approve',
      context,
    )
  }
  reject(id: number, companyId: number, reason: string, context: InvoiceMutationContext) {
    return this.transition(
      id,
      companyId,
      ['pending_approval'],
      "status='rejected', approval_status='rejected', rejected_by=?, rejected_at=NOW(), rejection_reason=?",
      [context.userId, reason],
      'reject',
      context,
    )
  }

  async cancel(id: number, companyId: number, reason: string, context: InvoiceMutationContext) {
    return transaction(async (connection) => {
      const invoice = await this.repository.findPurchase(connection, id, companyId, true)
      if (!invoice) throw new NotFoundError('Purchase invoice tidak ditemukan')
      if (!['draft', 'rejected'].includes(String(invoice.status)))
        throw new ConflictError('Hanya invoice Draft atau Rejected yang dapat dibatalkan')
      if (invoice.purchase_order_id || invoice.goods_receipt_id)
        throw new ConflictError(
          'Invoice terkait PO atau penerimaan tidak dapat dibatalkan langsung',
        )
      if (
        !(await this.repository.transitionPurchase(
          connection,
          id,
          companyId,
          ['draft', 'rejected'],
          "status='cancelled', cancelled_by=?, cancelled_at=NOW(), cancellation_reason=?",
          [context.userId, reason],
        ))
      )
        throw new ConflictError('Status purchase invoice telah berubah')
      await this.log(connection, companyId, context, 'cancel', id, String(invoice.invoice_number), {
        status: 'cancelled',
        reason,
      })
      return { id, status: 'cancelled' as const }
    })
  }

  async post(id: number, companyId: number, context: InvoiceMutationContext) {
    return transaction(async (connection) => {
      const invoice = await this.repository.findPurchase(connection, id, companyId, true)
      if (!invoice) throw new NotFoundError('Purchase invoice tidak ditemukan')
      if (invoice.status !== 'approved' && !(await prepareDirectPosting(connection,companyId,'purchase_invoices',id,String(invoice.status),context.userId)))
        throw new ConflictError('Hanya purchase invoice Approved yang dapat diposting')
      const payableAccountId = await this.mappings.resolve(connection, companyId, 'AP_CONTROL', invoice.payable_account_id ? Number(invoice.payable_account_id) : null)
      const lines = await this.repository.purchaseLines(connection, id)
      const debits = new Map<number, string>()
      const withholdingCredits = new Map<number, string>()
      const movementIds: number[] = []
      for (const line of lines) {
        const expenseAccountId = await this.mappings.resolve(
          connection,
          companyId,
          line.item_type === 'inventory' ? 'INVENTORY' : 'PURCHASE_EXPENSE',
          line.expense_account_id ? Number(line.expense_account_id) : null,
        )
        this.addAccount(
          debits,
          expenseAccountId,
          String(line.base_subtotal),
          'Akun persediaan/beban item belum dikonfigurasi',
        )
        if (compareDecimal(String(line.base_tax_amount), '0') > 0) {
          const inputTaxAccountId = await this.mappings.resolve(connection, companyId, 'INPUT_VAT', line.input_tax_account_id ? Number(line.input_tax_account_id) : null)
          this.addAccount(
            debits,
            inputTaxAccountId,
            String(line.base_tax_amount),
            'Akun pajak masukan belum dikonfigurasi',
          )
        }
        if (compareDecimal(String(line.base_withholding_amount ?? '0'), '0') > 0)
          this.addAccount(
            withholdingCredits,
            Number(line.withholding_account_id),
            String(line.base_withholding_amount),
            'Akun utang PPh pada baris invoice belum dikonfigurasi',
          )
        if (line.item_type === 'inventory') {
          if (!invoice.warehouse_id)
            throw new ValidationError('Gudang wajib diisi untuk invoice barang inventory')
          const movement = await this.inventory.applyMovement(connection, {
            companyId,
            itemId: Number(line.item_id),
            warehouseId: Number(invoice.warehouse_id),
            direction: 'in',
            quantity: String(line.stock_quantity ?? line.quantity),
            unitCost: divideDecimal(
              String(line.base_subtotal),
              2,
              String(line.stock_quantity ?? line.quantity),
              4,
              6,
            ),
            transactionType: 'purchase_invoice',
            transactionId: id,
            sourceLineId: Number(line.id),
            transactionNumber: String(invoice.invoice_number),
            movementDate: this.date(invoice.invoice_date),
            reference: invoice.reference ? String(invoice.reference) : null,
            postingKey: `purchase-invoice:${id}:line:${line.id}`,
            userId: context.userId,
          })
          movementIds.push(movement.movementId)
        }
      }
      const journals: JournalLineInput[] = [...debits].map(([accountId, amount]) => ({
        accountId,
        description: String(invoice.invoice_number),
        debit: amount,
        credit: '0',
      }))
      journals.push({
        accountId: payableAccountId,
        description: String(invoice.invoice_number),
        debit: '0',
        credit: String(invoice.base_grand_total),
      })
      for (const [accountId, amount] of withholdingCredits)
        journals.push({
          accountId,
          description: 'PPh dipotong ' + invoice.invoice_number,
          debit: '0',
          credit: amount,
        })
      const journalId = await this.posting.createPostedJournal(connection, {
        companyId,
        sourceType: 'purchase_invoice',
        sourceId: id,
        date: this.date(invoice.invoice_date),
        reference: String(invoice.invoice_number),
        description: `Purchase invoice ${invoice.invoice_number} - ${invoice.supplier_name}`,
        currency: String(invoice.currency),
        exchangeRate: String(invoice.exchange_rate),
        lines: journals,
        context,
      })
      if (movementIds.length)
        await connection.execute(
          `UPDATE inventory_movements SET journal_id=? WHERE id IN (${movementIds.map(() => '?').join(',')})`,
          [journalId, ...movementIds],
        )
      if (
        !(await this.repository.transitionPurchase(
          connection,
          id,
          companyId,
          ['approved'],
          "status='posted', journal_id=?, control_account_id=?, posted_by=?, posted_at=NOW()",
          [journalId, payableAccountId, context.userId],
        ))
      )
        throw new ConflictError('Status purchase invoice telah berubah')
      await this.log(connection, companyId, context, 'post', id, String(invoice.invoice_number), {
        status: 'posted',
        journalId,
      })
      return { id, status: 'posted' as const, journalId }
    })
  }

  async reverse(
    id: number,
    companyId: number,
    date: string,
    reason: string,
    context: InvoiceMutationContext,
  ) {
    return transaction(async (connection) => {
      const invoice = await this.repository.findPurchase(connection, id, companyId, true)
      if (!invoice) throw new NotFoundError('Purchase invoice tidak ditemukan')
      if (invoice.status !== 'posted')
        throw new ConflictError('Hanya purchase invoice Posted yang dapat direversal')
      if (compareDecimal(String(invoice.paid_amount), '0') > 0)
        throw new ConflictError('Invoice yang sudah dibayar tidak dapat direversal')
      const [activeReturns] = await connection.execute<RowDataPacket[]>(
        "SELECT id FROM purchase_returns WHERE purchase_invoice_id=? AND company_id=? AND status NOT IN ('cancelled','reversed') LIMIT 1",
        [id, companyId],
      )
      if (activeReturns.length)
        throw new ConflictError('Batalkan atau reversal retur terkait sebelum reversal invoice')
      const reversalJournalId = await this.posting.reversePostedJournal(connection, {
        companyId,
        journalId: Number(invoice.journal_id),
        date,
        reason,
        context,
        sourceType: 'purchase_invoice_reversal',
        sourceId: id,
      })
      const movementIds: number[] = []
      for (const movement of await this.repository.purchaseMovements(connection, companyId, id)) {
        const reversed = await this.inventory.reverseMovement(connection, {
          companyId,
          movementId: Number(movement.id),
          movementDate: date,
          transactionType: 'purchase_invoice_reversal',
          transactionId: id,
          transactionNumber: String(invoice.invoice_number),
          userId: context.userId,
          reference: reason,
        })
        movementIds.push(reversed.movementId)
      }
      if (movementIds.length)
        await connection.execute(
          `UPDATE inventory_movements SET journal_id=? WHERE id IN (${movementIds.map(() => '?').join(',')})`,
          [reversalJournalId, ...movementIds],
        )
      if (
        !(await this.repository.transitionPurchase(
          connection,
          id,
          companyId,
          ['posted'],
          "status='reversed', reversal_journal_id=?, reversed_by=?, reversed_at=NOW()",
          [reversalJournalId, context.userId],
        ))
      )
        throw new ConflictError('Status purchase invoice telah berubah')
      await this.log(
        connection,
        companyId,
        context,
        'reverse',
        id,
        String(invoice.invoice_number),
        { status: 'reversed', reversalJournalId, reason },
      )
      return { id, status: 'reversed' as const, reversalJournalId }
    })
  }

  /**
   * Creates one fully grouped imported purchase invoice on the caller-owned transaction.
   * This operation never posts a journal or changes inventory.
   */
  async createImported(
    connection: QueryExecutor,
    companyId: number,
    input: ImportedPurchaseInvoiceInput,
    context: InvoiceMutationContext,
  ): Promise<CreatedImportedInvoice> {
    if (!Number.isSafeInteger(companyId) || companyId <= 0) {
      throw new ValidationError('Company invoice tidak valid')
    }
    if (!Number.isSafeInteger(context.userId) || context.userId <= 0) {
      throw new ValidationError('User pembuat invoice tidak valid')
    }

    const parsed = importedPurchaseInvoiceSchema.parse(input)
    const duplicate = await this.repository.findPurchaseDuplicate(
      connection,
      companyId,
      parsed.invoiceNumber,
      parsed.supplierId,
      parsed.supplierInvoiceNumber,
    )
    if (duplicate) throw duplicateInvoiceError('purchase', parsed.invoiceNumber)

    const prepared = await prepareImportedInvoice(
      connection,
      companyId,
      'purchase',
      {
        invoiceNumber: parsed.invoiceNumber,
        invoiceDate: parsed.invoiceDate,
        dueDate: parsed.dueDate,
        partyId: parsed.supplierId,
        warehouseId: parsed.warehouseId,
        currency: parsed.currency,
        exchangeRate: parsed.exchangeRate,
        lines: parsed.lines.map(({ expenseAccountId, ...line }) => ({
          ...line,
          accountId: expenseAccountId,
        })),
      },
      this.repository,
      this.validation,
    )
    const status = importedStatus(parsed.importAs)
    const id = await this.repository.insertPurchase(connection, {
      companyId,
      invoiceNumber: parsed.invoiceNumber,
      supplierInvoiceNumber: parsed.supplierInvoiceNumber,
      invoiceDate: parsed.invoiceDate,
      dueDate: parsed.dueDate,
      supplierId: parsed.supplierId,
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
      module: 'purchase-invoices',
      action: 'create_imported',
      recordType: 'purchase_invoice',
      recordId: id,
      recordNumber: parsed.invoiceNumber,
      newValue: {
        status,
        supplierId: parsed.supplierId,
        invoiceDate: parsed.invoiceDate,
        grandTotal: prepared.totals.grandTotal,
      },
      requestId: context.requestId,
      ip: context.ip,
      metadata: { source: 'data_import', lineCount: prepared.lines.length },
    })

    return { id, invoiceNumber: parsed.invoiceNumber, status, totals: prepared.totals }
  }

  private async applyWithholding(
    connection: QueryExecutor,
    companyId: number,
    id: number,
    input: PurchaseInvoiceInput,
  ) {
    const invoice = await this.repository.findPurchase(connection, id, companyId, true)
    if (!invoice) throw new NotFoundError('Invoice tidak ditemukan')
    const lines = await this.repository.purchaseLines(connection, id)
    const selectedTaxIds = [
      ...new Set(
        input.lines
          .map((line) => line.withholding_tax_id)
          .filter((value): value is number => Boolean(value)),
      ),
    ]
    const taxes = new Map(
      (await this.repository.findTaxCodes(connection, companyId, selectedTaxIds)).map((tax) => [
        Number(tax.id),
        tax,
      ]),
    )
    let amount = '0.00',
      base = '0.00'
    const usedTaxIds = new Set<number>(),
      usedAccountIds = new Set<number>()
    for (const [index, line] of lines.entries()) {
      const taxId = input.lines[index]?.withholding_tax_id ?? null
      let lineAmount = '0.00',
        lineBase = '0.00',
        rate = '0.0000',
        accountId: number | null = null
      if (taxId) {
        const tax = taxes.get(taxId)
        if (!tax || tax.tax_type !== 'withholding' || !tax.output_tax_account_id)
          throw new ValidationError(
            `PPh pada baris ${index + 1} tidak aktif atau belum memiliki akun utang pajak`,
          )
        if (line.item_type === 'inventory')
          throw new ValidationError(
            `PPh jasa tidak boleh diterapkan pada barang persediaan di baris ${index + 1}`,
          )
        accountId = Number(tax.output_tax_account_id)
        await this.validation.ensureActiveReference(connection, {
          companyId,
          table: 'accounts',
          id: accountId,
          label: 'Utang pajak',
          postingOnly: true,
        })
        rate = String(tax.rate)
        lineAmount = percentageOf(String(line.subtotal), tax.rate)
        lineBase = multiplyDecimal(lineAmount, 2, input.exchange_rate, 8)
        amount = addDecimal([amount, lineAmount])
        base = addDecimal([base, lineBase])
        usedTaxIds.add(taxId)
        usedAccountIds.add(accountId)
      }
      await connection.execute(
        'UPDATE purchase_invoice_lines SET withholding_tax_id=?,withholding_rate=?,withholding_amount=?,base_withholding_amount=?,withholding_account_id=? WHERE id=? AND purchase_invoice_id=?',
        [taxId, rate, lineAmount, lineBase, accountId, line.id, id],
      )
    }
    const net = subtractDecimal(String(invoice.grand_total), amount)
    if (compareDecimal(net, '0') <= 0)
      throw new ValidationError('Total bersih invoice harus lebih dari nol')
    await connection.execute(
      'UPDATE purchase_invoices SET withholding_tax_id=?,withholding_amount=?,base_withholding_amount=?,withholding_account_id=?,grand_total=?,base_grand_total=?,outstanding_amount=? WHERE id=? AND company_id=?',
      [
        usedTaxIds.size === 1 ? [...usedTaxIds][0] : null,
        amount,
        base,
        usedAccountIds.size === 1 ? [...usedAccountIds][0] : null,
        net,
        subtractDecimal(String(invoice.base_grand_total), base),
        net,
        id,
        companyId,
      ],
    )
  }

  private async prepare(
    connection: QueryExecutor,
    companyId: number,
    invoiceNumber: string,
    input: PurchaseInvoiceInput,
    userId: number,
  ): Promise<PurchaseInvoiceWrite> {
    const prepared = await prepareImportedInvoice(
      connection,
      companyId,
      'purchase',
      {
        invoiceNumber,
        invoiceDate: input.invoice_date,
        dueDate: input.due_date,
        partyId: input.supplier_id,
        warehouseId: input.warehouse_id ?? null,
        currency: input.currency,
        exchangeRate: input.exchange_rate,
        lines: input.lines.map((line) => ({
          itemId: line.item_id,
          description: line.description ?? null,
          quantity: line.quantity,
          unitId: line.unit_id ?? null,
          unitPrice: line.unit_price,
          discount: line.discount,
          discountPercent: line.discount_percent,
          taxCodeId: line.tax_code_id ?? null,
          accountId: line.expense_account_id ?? null,
        })),
      },
      this.repository,
      this.validation,
    )
    return {
      companyId,
      invoiceNumber,
      supplierInvoiceNumber: input.supplier_invoice_number,
      invoiceDate: input.invoice_date,
      dueDate: input.due_date,
      supplierId: input.supplier_id,
      warehouseId: prepared.warehouseId,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      currency: input.currency,
      exchangeRate: input.exchange_rate,
      status: 'draft',
      accountingPeriodId: prepared.accountingPeriodId,
      userId,
      totals: prepared.totals,
      lines: prepared.lines,
    }
  }

  private async transition(
    id: number,
    companyId: number,
    from: string[],
    fields: string,
    values: Array<string | number | Date | null>,
    action: string,
    context: InvoiceMutationContext,
  ) {
    return transaction(async (connection) => {
      const invoice = await this.repository.findPurchase(connection, id, companyId, true)
      if (!invoice) throw new NotFoundError('Purchase invoice tidak ditemukan')
      if (!from.includes(String(invoice.status)))
        throw new ConflictError(`Purchase invoice ${invoice.status} tidak dapat diproses`)
      if (action === 'submit')
        await this.validation.ensurePurchaseOrderPolicy(
          connection,
          companyId,
          invoice.purchase_order_id ? Number(invoice.purchase_order_id) : null,
          invoice.goods_receipt_id ? Number(invoice.goods_receipt_id) : null,
        )
      if (action === 'approve')
        await this.validation.ensureIndependentApprover(
          connection,
          companyId,
          invoice.submitted_by ? Number(invoice.submitted_by) : null,
          context.userId,
        )
      if (
        !(await this.repository.transitionPurchase(connection, id, companyId, from, fields, values))
      )
        throw new ConflictError('Status purchase invoice telah berubah')
      const status =
        action === 'submit' ? 'pending_approval' : action === 'approve' ? 'approved' : 'rejected'
      await this.log(connection, companyId, context, action, id, String(invoice.invoice_number), {
        status,
      })
      return { id, status }
    })
  }

  private addAccount(map: Map<number, string>, accountId: number, amount: string, message: string) {
    if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new ValidationError(message)
    map.set(accountId, addDecimal([map.get(accountId) ?? '0', amount]))
  }
  private date(value: Date | string) {
    return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)
  }
  private async log(
    connection: QueryExecutor,
    companyId: number,
    context: InvoiceMutationContext,
    action: string,
    id: number,
    number: string,
    newValue: Record<string, unknown>,
  ) {
    await this.audit.log(connection, {
      companyId,
      userId: context.userId,
      module: 'purchase-invoices',
      action,
      recordType: 'purchase_invoice',
      recordId: id,
      recordNumber: number,
      newValue,
      requestId: context.requestId,
      ip: context.ip,
    })
  }
}
