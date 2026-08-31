import type { QueryExecutor } from '../types/database'

import { transaction } from '../config/database'
import { JOURNAL_STATUS } from '../constants/accounting'
import {
  JournalRepository,
  type JournalLineWrite,
  type JournalWrite,
} from '../repositories/JournalRepository'
import { ConflictError, NotFoundError, ValidationError } from '../utils/AppError'
import {
  compareDecimal,
  fromScaledInteger,
  normalizeDecimal,
  sumScaled,
  type DecimalInput,
} from '../utils/decimal'
import { AuditService, type AuditInput } from './AuditService'
import { BusinessValidationService } from './BusinessValidationService'
import { NumberSequenceService } from './NumberSequenceService'

export interface JournalLineInput {
  accountId: number
  description?: string | null
  costCenterId?: number | null
  projectId?: number | null
  debit: DecimalInput
  credit: DecimalInput
}

export interface PostingContext {
  userId: number
  requestId?: string | null
  ip?: string | null
}

export interface SourceJournalInput {
  companyId: number
  sourceType: string
  sourceId: number
  date: string
  reference?: string | null
  description: string
  currency?: string
  exchangeRate?: DecimalInput
  lines: JournalLineInput[]
  context: PostingContext
}

export interface ReverseJournalInput {
  companyId: number
  journalId: number
  date: string
  reason: string
  context: PostingContext
  sourceType?: string
  sourceId?: number
}

export function assertBalanced(lines: JournalLineInput[]) {
  if (lines.length < 2) throw new ValidationError('Jurnal minimal mempunyai dua baris')

  for (const [index, line] of lines.entries()) {
    const debit = normalizeDecimal(line.debit)
    const credit = normalizeDecimal(line.credit)
    const debitPositive = compareDecimal(debit, '0') > 0
    const creditPositive = compareDecimal(credit, '0') > 0
    if (compareDecimal(debit, '0') < 0 || compareDecimal(credit, '0') < 0) {
      throw new ValidationError(`Nilai baris jurnal ${index + 1} tidak boleh negatif`)
    }
    if (debitPositive === creditPositive) {
      throw new ValidationError(`Baris jurnal ${index + 1} harus debit atau kredit saja`)
    }
  }

  const debitMinor = sumScaled(lines.map((line) => line.debit))
  const creditMinor = sumScaled(lines.map((line) => line.credit))
  if (debitMinor !== creditMinor) {
    throw new ValidationError('Jurnal tidak balance', {
      debit: fromScaledInteger(debitMinor),
      credit: fromScaledInteger(creditMinor),
      difference: fromScaledInteger(debitMinor - creditMinor),
    })
  }
  if (debitMinor <= 0n) throw new ValidationError('Nilai jurnal harus lebih dari nol')

  return {
    totalDebit: fromScaledInteger(debitMinor),
    totalCredit: fromScaledInteger(creditMinor),
  }
}

export class PostingService {
  constructor(
    private journals = new JournalRepository(),
    private sequences = new NumberSequenceService(),
    private validation = new BusinessValidationService(),
    private audit = new AuditService(),
  ) {}

  async validateLines(connection: QueryExecutor, companyId: number, lines: JournalLineInput[]) {
    const totals = assertBalanced(lines)
    for (const line of lines) {
      await this.validation.ensureActiveReference(connection, {
        table: 'accounts',
        id: line.accountId,
        companyId,
        label: 'Akun jurnal',
        postingOnly: true,
      })
      if (line.costCenterId) {
        await this.validation.ensureActiveReference(connection, {
          table: 'cost_centers',
          id: line.costCenterId,
          companyId,
          label: 'Pusat biaya',
        })
      }
      if (line.projectId) {
        await this.validation.ensureActiveReference(connection, {
          table: 'projects',
          id: line.projectId,
          companyId,
          label: 'Proyek',
        })
      }
    }
    return totals
  }

  toJournalLines(lines: JournalLineInput[], exchangeRate: DecimalInput = '1'): JournalLineWrite[] {
    const normalizedRate = normalizeDecimal(exchangeRate, 8)
    return lines.map((line) => ({
      accountId: line.accountId,
      description: line.description,
      costCenterId: line.costCenterId,
      projectId: line.projectId,
      debit: normalizeDecimal(line.debit),
      credit: normalizeDecimal(line.credit),
      currencyDebit: normalizeDecimal(line.debit),
      currencyCredit: normalizeDecimal(line.credit),
      exchangeRate: normalizedRate,
    }))
  }

  async createPostedJournal(connection: QueryExecutor, input: SourceJournalInput) {
    await this.validation.ensureOpenPeriod(connection, input.companyId, input.date)
    const existing = await this.journals.findPostedSource(
      connection,
      input.companyId,
      input.sourceType,
      input.sourceId,
    )
    if (existing) throw new ConflictError('Transaksi sudah pernah diposting')

    const totals = await this.validateLines(connection, input.companyId, input.lines)
    const number = await this.sequences.next(connection, input.companyId, 'journal', input.date)
    const journalId = await this.journals.create(connection, {
      companyId: input.companyId,
      number,
      date: input.date,
      reference: input.reference,
      description: input.description,
      currency: input.currency ?? 'IDR',
      exchangeRate: normalizeDecimal(input.exchangeRate ?? '1', 8),
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      status: JOURNAL_STATUS.POSTED,
      userId: input.context.userId,
      totalDebit: totals.totalDebit,
      totalCredit: totals.totalCredit,
      lines: this.toJournalLines(input.lines, input.exchangeRate),
    })
    await this.journals.transition(connection, journalId, JOURNAL_STATUS.POSTED, {
      posted_by: input.context.userId,
      posted_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    })
    await this.audit.log(connection, {
      companyId: input.companyId,
      userId: input.context.userId,
      module: 'accounting',
      action: 'post',
      recordType: 'journal',
      recordId: journalId,
      newValue: { sourceType: input.sourceType, sourceId: input.sourceId, status: 'posted' },
      requestId: input.context.requestId,
      ip: input.context.ip,
    })
    return journalId
  }

  async postManual(id: number, companyId: number, contextOrUserId: PostingContext | number) {
    const context =
      typeof contextOrUserId === 'number' ? { userId: contextOrUserId } : contextOrUserId
    return transaction(async (connection) => {
      const journal = await this.journals.findForUpdate(connection, id, companyId)
      if (!journal) throw new NotFoundError('Jurnal tidak ditemukan')
      if (journal.status === JOURNAL_STATUS.POSTED || journal.status === JOURNAL_STATUS.REVERSED) {
        throw new ConflictError('Jurnal sudah pernah diposting')
      }
      if (journal.status !== JOURNAL_STATUS.APPROVED) {
        throw new ConflictError('Hanya jurnal yang sudah disetujui dapat diposting')
      }

      const date = this.dateOnly(journal.journal_date)
      await this.validation.ensureOpenPeriod(connection, companyId, date)
      const lines = await this.journals.lines(connection, id)
      await this.validateLines(
        connection,
        companyId,
        lines.map((line) => ({
          accountId: Number(line.account_id),
          costCenterId: line.cost_center_id ? Number(line.cost_center_id) : null,
          projectId: line.project_id ? Number(line.project_id) : null,
          debit: line.debit,
          credit: line.credit,
        })),
      )
      await this.journals.transition(connection, id, JOURNAL_STATUS.POSTED, {
        posted_by: context.userId,
        posted_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      })
      await this.audit.log(connection, this.auditInput(companyId, context, 'post', id))
      return { id, status: JOURNAL_STATUS.POSTED }
    })
  }

  async reversePostedJournal(connection: QueryExecutor, input: ReverseJournalInput) {
    const original = await this.journals.findForUpdate(connection, input.journalId, input.companyId)
    if (!original) throw new NotFoundError('Jurnal asal tidak ditemukan')
    if (original.status === JOURNAL_STATUS.REVERSED || original.reversal_journal_id) {
      throw new ConflictError('Jurnal sudah pernah direversal')
    }
    if (original.status !== JOURNAL_STATUS.POSTED) {
      throw new ConflictError('Hanya jurnal posted yang dapat direversal')
    }

    await this.validation.ensureOpenPeriod(connection, input.companyId, input.date)
    const originalLines = await this.journals.lines(connection, input.journalId)
    const reversalLines: JournalLineInput[] = originalLines.map((line) => ({
      accountId: Number(line.account_id),
      description: `Reversal: ${input.reason}`,
      costCenterId: line.cost_center_id ? Number(line.cost_center_id) : null,
      projectId: line.project_id ? Number(line.project_id) : null,
      debit: line.credit,
      credit: line.debit,
    }))
    const totals = await this.validateLines(connection, input.companyId, reversalLines)
    const number = await this.sequences.next(connection, input.companyId, 'journal', input.date)
    const reversalId = await this.journals.create(connection, {
      companyId: input.companyId,
      number,
      date: input.date,
      reference: original.journal_number,
      description: `Reversal ${original.journal_number}: ${input.reason}`,
      currency: String(original.currency ?? 'IDR'),
      exchangeRate: String(original.exchange_rate ?? '1'),
      sourceType: input.sourceType ?? `${original.source_type ?? 'journal'}_reversal`,
      sourceId: input.sourceId ?? Number(original.source_id ?? original.id),
      status: JOURNAL_STATUS.POSTED,
      userId: input.context.userId,
      totalDebit: totals.totalDebit,
      totalCredit: totals.totalCredit,
      originalJournalId: original.id,
      lines: this.toJournalLines(reversalLines, String(original.exchange_rate ?? '1')),
    })
    const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
    await this.journals.transition(connection, reversalId, JOURNAL_STATUS.POSTED, {
      posted_by: input.context.userId,
      posted_at: timestamp,
    })
    await this.journals.transition(connection, original.id, JOURNAL_STATUS.REVERSED, {
      reversed_by: input.context.userId,
      reversed_at: timestamp,
      reversal_journal_id: reversalId,
    })
    await this.audit.log(connection, {
      ...this.auditInput(input.companyId, input.context, 'reverse', original.id),
      newValue: { status: 'reversed', reversalJournalId: reversalId, reason: input.reason },
    })
    return reversalId
  }

  async reverseManual(input: ReverseJournalInput) {
    return transaction((connection) => this.reversePostedJournal(connection, input))
  }

  private dateOnly(value: Date | string) {
    if (value instanceof Date) return value.toISOString().slice(0, 10)
    return String(value).slice(0, 10)
  }

  private auditInput(
    companyId: number,
    context: PostingContext,
    action: string,
    recordId: number,
  ): AuditInput {
    return {
      companyId,
      userId: context.userId,
      module: 'accounting',
      action,
      recordType: 'journal',
      recordId,
      requestId: context.requestId,
      ip: context.ip,
      newValue: { status: action === 'post' ? 'posted' : action },
    }
  }
}
