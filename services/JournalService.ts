import { transaction } from '../config/database'
import { JournalRepository } from '../repositories/JournalRepository'
import { ConflictError, NotFoundError } from '../utils/AppError'
import type { z } from 'zod'

import type { journalSchema } from '../validators/journal.validator'
import { AuditService } from './AuditService'
import { BusinessValidationService } from './BusinessValidationService'
import { NumberSequenceService } from './NumberSequenceService'
import { PostingService, assertBalanced, type PostingContext } from './PostingService'

type JournalInput = z.infer<typeof journalSchema>

export class JournalService {
  constructor(
    private repository = new JournalRepository(),
    private sequences = new NumberSequenceService(),
    private validation = new BusinessValidationService(),
    private posting = new PostingService(),
    private audit = new AuditService(),
  ) {}

  list(
    companyId: number,
    query: {
      page?: string
      limit?: string
      search?: string
      status?: string
      date_from?: string
      date_to?: string
      source_type?: string
    },
  ) {
    return this.repository.list(companyId, {
      ...query,
      dateFrom: query.date_from,
      dateTo: query.date_to,
      sourceType: query.source_type,
    })
  }

  async get(id: number, companyId: number) {
    const journal = await this.repository.detail(id, companyId)
    if (!journal) throw new NotFoundError('Jurnal tidak ditemukan')
    return journal
  }

  async create(companyId: number, input: JournalInput, context: PostingContext) {
    return transaction(async (connection) => {
      await this.validation.ensureOpenPeriod(connection, companyId, input.journal_date)
      const totals = await this.posting.validateLines(connection, companyId, input.lines)
      const number = await this.sequences.next(connection, companyId, 'journal', input.journal_date)
      const id = await this.repository.create(connection, {
        companyId,
        number,
        date: input.journal_date,
        reference: input.reference,
        description: input.description,
        currency: input.currency,
        exchangeRate: input.exchange_rate,
        status: 'draft',
        userId: context.userId,
        totalDebit: totals.totalDebit,
        totalCredit: totals.totalCredit,
        lines: this.posting.toJournalLines(input.lines, input.exchange_rate),
      })
      await this.audit.log(connection, {
        companyId,
        userId: context.userId,
        module: 'accounting',
        action: 'create',
        recordType: 'journal',
        recordId: id,
        newValue: { journalNumber: number, status: 'draft', total: totals.totalDebit },
        requestId: context.requestId,
        ip: context.ip,
      })
      return { id, journalNumber: number, status: 'draft' }
    })
  }

  async update(id: number, companyId: number, input: JournalInput, context: PostingContext) {
    await transaction(async (connection) => {
      const journal = await this.repository.findForUpdate(connection, id, companyId)
      if (!journal) throw new NotFoundError('Jurnal tidak ditemukan')
      this.ensureManual(journal.source_type)
      if (!['draft', 'rejected'].includes(journal.status)) {
        throw new ConflictError('Hanya jurnal draft atau rejected yang dapat diubah')
      }
      await this.validation.ensureOpenPeriod(connection, companyId, this.dateOnly(journal.journal_date))
      await this.validation.ensureOpenPeriod(connection, companyId, input.journal_date)
      const totals = await this.posting.validateLines(connection, companyId, input.lines)
      await this.repository.updateDraft(connection, id, {
        date: input.journal_date,
        reference: input.reference,
        description: input.description,
        currency: input.currency,
        exchangeRate: input.exchange_rate,
        totalDebit: totals.totalDebit,
        totalCredit: totals.totalCredit,
        originalJournalId: journal.original_journal_id,
        lines: this.posting.toJournalLines(input.lines, input.exchange_rate),
      })
      await this.audit.log(connection, {
        companyId,
        userId: context.userId,
        module: 'accounting',
        action: 'update',
        recordType: 'journal',
        recordId: id,
        oldValue: { version: journal.version, status: journal.status },
        newValue: { version: Number(journal.version) + 1, status: 'draft' },
        requestId: context.requestId,
        ip: context.ip,
      })
    })
    return this.get(id, companyId)
  }

  async remove(id: number, companyId: number, context: PostingContext) {
    return transaction(async (connection) => {
      const journal = await this.repository.findForUpdate(connection, id, companyId)
      if (!journal) throw new NotFoundError('Jurnal tidak ditemukan')
      this.ensureManual(journal.source_type)
      if (journal.status !== 'draft') throw new ConflictError('Hanya jurnal draft yang dapat dihapus')
      await this.validation.ensureOpenPeriod(connection, companyId, this.dateOnly(journal.journal_date))
      await this.repository.removeDraft(connection, id)
      await this.audit.log(connection, {
        companyId,
        userId: context.userId,
        module: 'accounting',
        action: 'delete',
        recordType: 'journal',
        recordId: id,
        oldValue: { journalNumber: journal.journal_number, status: journal.status },
        requestId: context.requestId,
        ip: context.ip,
      })
    })
  }

  async submit(id: number, companyId: number, context: PostingContext) {
    return this.transition(id, companyId, context, {
      allowed: ['draft', 'rejected'],
      status: 'pending_approval',
      action: 'submit',
      fields: { submitted_by: context.userId, submitted_at: this.timestamp() },
    })
  }

  async approve(id: number, companyId: number, context: PostingContext) {
    return this.transition(id, companyId, context, {
      allowed: ['pending_approval'],
      status: 'approved',
      action: 'approve',
      fields: { approved_by: context.userId, approved_at: this.timestamp() },
    })
  }

  async reject(
    id: number,
    companyId: number,
    comments: string,
    context: PostingContext,
  ) {
    return this.transition(id, companyId, context, {
      allowed: ['pending_approval'],
      status: 'rejected',
      action: 'reject',
      fields: {
        rejected_by: context.userId,
        rejected_at: this.timestamp(),
        rejection_reason: comments,
      },
    })
  }

  post(id: number, companyId: number, context: PostingContext) {
    return this.posting.postManual(id, companyId, context)
  }

  reverse(
    id: number,
    companyId: number,
    reversalDate: string,
    reason: string,
    context: PostingContext,
  ) {
    return this.posting.reverseManual({
      companyId,
      journalId: id,
      date: reversalDate,
      reason,
      context,
    })
  }

  private async transition(
    id: number,
    companyId: number,
    context: PostingContext,
    change: {
      allowed: string[]
      status: string
      action: string
      fields: Record<string, string | number | null>
    },
  ) {
    await transaction(async (connection) => {
      const journal = await this.repository.findForUpdate(connection, id, companyId)
      if (!journal) throw new NotFoundError('Jurnal tidak ditemukan')
      this.ensureManual(journal.source_type)
      if (!change.allowed.includes(journal.status)) {
        throw new ConflictError(`Jurnal berstatus ${journal.status} tidak dapat ${change.action}`)
      }
      await this.validation.ensureOpenPeriod(connection, companyId, this.dateOnly(journal.journal_date))
      const lines = await this.repository.lines(connection, id)
      assertBalanced(lines.map((line) => ({
        accountId: Number(line.account_id),
        debit: line.debit,
        credit: line.credit,
      })))
      await this.repository.transition(connection, id, change.status, change.fields)
      await this.audit.log(connection, {
        companyId,
        userId: context.userId,
        module: 'accounting',
        action: change.action,
        recordType: 'journal',
        recordId: id,
        oldValue: { status: journal.status },
        newValue: { status: change.status },
        requestId: context.requestId,
        ip: context.ip,
      })
    })
    return { id, status: change.status }
  }

  private ensureManual(sourceType: string | null) {
    if (sourceType) throw new ConflictError('Jurnal sumber transaksi dikelola dari dokumen asal')
  }

  private timestamp() {
    return new Date().toISOString().slice(0, 19).replace('T', ' ')
  }

  private dateOnly(value: Date | string) {
    return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)
  }
}
