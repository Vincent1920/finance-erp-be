// src/services/CustomerPaymentService.ts
import { transaction } from '../config/database'
import { CustomerPaymentRepository } from '../repositories/CustomerPaymentRepository'
import { NumberSequenceService } from './NumberSequenceService'
import { PostingService, type JournalLineInput } from './PostingService'
import { BusinessValidationService } from './BusinessValidationService'
import { AuditService } from './AuditService'
import { NotFoundError, ConflictError, ValidationError } from '../utils/AppError'
import type { DatabaseValue } from '../types/database'
import { addDecimal, multiplyDecimal, subtractDecimal } from '../utils/decimal'
import type { CustomerPaymentInput as PaymentInput } from '../validators/customer-payment.validator'
import type { InvoiceMutationContext } from './InvoiceDomainSupport'

export class CustomerPaymentService {
  private repo = new CustomerPaymentRepository()
  private seq = new NumberSequenceService()
  private posting = new PostingService()
  private audit = new AuditService()
  private validation = new BusinessValidationService()

  // List payments (pagination)
  list(companyId: number, query: { offset: number; limit: number }) {
    return this.repo.list(companyId, query)
  }

  // Get detail
  async get(id: number, companyId: number) {
    const rec = await this.repo.detail(id, companyId)
    return rec
  }

  // Create draft payment
  async create(companyId: number, input: PaymentInput, ctx: InvoiceMutationContext) {
    return transaction(async (conn) => {
      const [companies]=await conn.execute<import('mysql2/promise').RowDataPacket[]>('SELECT base_currency FROM companies WHERE id=?',[companyId])
      if(input.currency!==companies[0]!.base_currency)throw new ValidationError('Gunakan menu Pelunasan Penjualan untuk penerimaan valas dengan alokasi historis dan jurnal selisih kurs')
      // Ensure open period
      await this.validation.ensureOpenPeriod(conn, companyId, input.payment_date)

      // Generate document number
      const number = await this.seq.next(conn, companyId, 'customer_payment', input.payment_date)

      const baseAmount = multiplyDecimal(input.amount, 2, input.exchange_rate, 8)
      const allocatedAmount = addDecimal((input.allocations ?? []).map((item) => item.amount))
      const unallocatedAmount = subtractDecimal(input.amount, allocatedAmount)

      // Insert draft record and allocations
      const paymentId = await this.repo.insert(
        conn,
        {
          companyId,
          number,
          paymentDate: input.payment_date,
          customerId: input.customer_id,
          bankAccountId: input.bank_account_id,
          cashAccountId: input.cash_account_id,
          paymentMethod: input.payment_method,
          reference: input.reference,
          amount: input.amount,
          baseAmount,
          unallocatedAmount,
          currency: input.currency,
          exchangeRate: input.exchange_rate,
          notes: input.notes ?? null,
          userId: ctx.userId,
        },
        input.allocations?.map((a) => ({
          invoiceId: a.invoice_id,
          amount: a.amount,
          baseAmount: multiplyDecimal(a.amount, 2, input.exchange_rate, 8),
        })) ?? [],
      )

      await this.audit.log(conn, {
        companyId,
        userId: ctx.userId,
        module: 'customer-payments',
        action: 'create',
        recordType: 'customer_payment',
        recordId: paymentId,
        recordNumber: number,
        newValue: { status: 'draft', amount: input.amount },
        requestId: ctx.requestId,
        ip: ctx.ip,
      })

      return { id: paymentId, number, status: 'draft' as const }
    })
  }

  // Submit for approval
  async submit(id: number, companyId: number, ctx: InvoiceMutationContext) {
    return this.transition(
      id,
      companyId,
      ['draft', 'rejected'],
      "status='pending_approval', submitted_by=?, submitted_at=NOW()",
      [ctx.userId],
      'submit',
      ctx,
    )
  }

  // Approve
  async approve(id: number, companyId: number, ctx: InvoiceMutationContext) {
    return this.transition(
      id,
      companyId,
      ['pending_approval'],
      "status='approved', approved_by=?, approved_at=NOW()",
      [ctx.userId],
      'approve',
      ctx,
    )
  }

  // Cancel draft or rejected
  async cancel(id: number, companyId: number, reason: string, ctx: InvoiceMutationContext) {
    return transaction(async (conn) => {
      const rec = await this.repo.find(conn, id, companyId, true)
      if (!rec) throw new NotFoundError('Penerimaan piutang tidak ditemukan')
      if (!['draft', 'rejected'].includes(String(rec.status)))
        throw new ConflictError('Hanya draft atau rejected yang dapat dibatalkan')
      const ok = await this.repo.transition(
        conn,
        id,
        companyId,
        ['draft', 'rejected'],
        "status='cancelled', cancelled_by=?, cancelled_at=NOW(), cancellation_reason=?",
        [ctx.userId, reason],
      )
      if (!ok) throw new ConflictError('Gagal membatalkan')
      await this.audit.log(conn, {
        companyId,
        userId: ctx.userId,
        module: 'customer-payments',
        action: 'cancel',
        recordType: 'customer_payment',
        recordId: id,
        recordNumber: rec.payment_number,
        newValue: { status: 'cancelled', reason },
        requestId: ctx.requestId,
        ip: ctx.ip,
      })
      return { id, status: 'cancelled' as const }
    })
  }

  // Post (create journal entries and allocate to invoices)
  async post(id: number, companyId: number, ctx: InvoiceMutationContext) {
    return transaction(async (conn) => {
      const rec = await this.repo.find(conn, id, companyId, true)
      if (!rec) throw new NotFoundError('Penerimaan piutang tidak ditemukan')
      if (rec.status !== 'approved')
        throw new ConflictError('Hanya pembayaran yang approved dapat diposting')
      const [companies]=await conn.execute<import('mysql2/promise').RowDataPacket[]>('SELECT base_currency FROM companies WHERE id=?',[companyId])
      if(rec.currency!==companies[0]!.base_currency)throw new ValidationError('Draft penerimaan valas lama harus dicatat melalui menu Pelunasan Penjualan agar selisih kurs dan nominal bank benar')

      // Verify receivable account configuration
      const receivableAccountId = await this.repo.setting(
        conn,
        companyId,
        'accounts_receivable_account_id',
      )
      if (!receivableAccountId)
        throw new ValidationError('Akun Piutang belum dikonfigurasi pada Settings')

      // Build journal lines: debit cash/bank, credit receivable, plus allocations if any
      const journals: JournalLineInput[] = []
      journals.push({
        accountId: Number(rec.cash_account_id),
        debit: rec.base_amount,
        credit: '0',
        description: String(rec.payment_number),
      })
      journals.push({
        accountId: Number(receivableAccountId),
        debit: '0',
        credit: rec.base_amount,
        description: String(rec.payment_number),
      })

      // Create posted journal
      const journalId = await this.posting.createPostedJournal(conn, {
        companyId,
        sourceType: 'customer_payment',
        sourceId: id,
        date: this.dateOnly(rec.payment_date),
        reference: String(rec.payment_number),
        description: `Penerimaan piutang ${rec.payment_number}`,
        lines: journals,
        context: ctx,
      })

      // Update status
      const ok = await this.repo.transition(
        conn,
        id,
        companyId,
        ['approved'],
        "status='posted', journal_id=?, posted_by=?, posted_at=NOW()",
        [journalId, ctx.userId],
      )
      if (!ok) throw new ConflictError('Gagal memperbarui status posting')

      await this.audit.log(conn, {
        companyId,
        userId: ctx.userId,
        module: 'customer-payments',
        action: 'post',
        recordType: 'customer_payment',
        recordId: id,
        recordNumber: rec.payment_number,
        newValue: { status: 'posted', journalId },
        requestId: ctx.requestId,
        ip: ctx.ip,
      })

      return { id, status: 'posted' as const, journalId }
    })
  }

  // Reverse posted payment
  async reverse(
    id: number,
    companyId: number,
    date: string,
    reason: string,
    ctx: InvoiceMutationContext,
  ) {
    return transaction(async (conn) => {
      const rec = await this.repo.find(conn, id, companyId, true)
      if (!rec) throw new NotFoundError('Penerimaan piutang tidak ditemukan')
      if (rec.status !== 'posted')
        throw new ConflictError('Hanya pembayaran yang posted dapat direversal')

      const reversalJournalId = await this.posting.reversePostedJournal(conn, {
        companyId,
        journalId: Number(rec.journal_id),
        date,
        reason,
        context: ctx,
        sourceType: 'customer_payment_reversal',
        sourceId: id,
      })

      const ok = await this.repo.transition(
        conn,
        id,
        companyId,
        ['posted'],
        "status='reversed', reversal_journal_id=?, reversed_by=?, reversed_at=NOW()",
        [reversalJournalId, ctx.userId],
      )
      if (!ok) throw new ConflictError('Gagal mengubah status reversal')

      await this.audit.log(conn, {
        companyId,
        userId: ctx.userId,
        module: 'customer-payments',
        action: 'reverse',
        recordType: 'customer_payment',
        recordId: id,
        recordNumber: rec.payment_number,
        newValue: { status: 'reversed', reversalJournalId, reason },
        requestId: ctx.requestId,
        ip: ctx.ip,
      })
      return { id, status: 'reversed' as const, reversalJournalId }
    })
  }

  // Helper to unify transition logic used by submit/approve
  private async transition(
    id: number,
    companyId: number,
    from: string[],
    setClause: string,
    values: DatabaseValue[],
    action: string,
    ctx: InvoiceMutationContext,
  ) {
    return transaction(async (conn) => {
      const rec = await this.repo.find(conn, id, companyId, true)
      if (!rec) throw new NotFoundError('Penerimaan piutang tidak ditemukan')
      if (!from.includes(String(rec.status)))
        throw new ConflictError(`Status ${rec.status} tidak dapat diproses untuk ${action}`)
      const ok = await this.repo.transition(conn, id, companyId, from, setClause, values)
      if (!ok) throw new ConflictError('Gagal memperbarui status')
      const newStatus =
        action === 'submit' ? 'pending_approval' : action === 'approve' ? 'approved' : rec.status
      await this.audit.log(conn, {
        companyId,
        userId: ctx.userId,
        module: 'customer-payments',
        action,
        recordType: 'customer_payment',
        recordId: id,
        recordNumber: rec.payment_number,
        newValue: { status: newStatus },
        requestId: ctx.requestId,
        ip: ctx.ip,
      })
      return { id, status: newStatus }
    })
  }

  private dateOnly(value: Date | string) {
    return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)
  }
}
