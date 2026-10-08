import type { RowDataPacket } from 'mysql2/promise'
import { validateFxPolicy } from './AccountingPolicyService'
import { AccountMappingService } from './AccountMappingService'
import { assertManualAccounts } from './CoaControlService'
import type { QueryExecutor } from '../types/database'
import { prepareDirectPosting } from './WorkflowPolicyService'

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
  currencyDebit?: DecimalInput
  currencyCredit?: DecimalInput
  currencyCode?: string | null
  exchangeRate?: DecimalInput
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
    const [foreignBanks] = await connection.execute<import('mysql2/promise').RowDataPacket[]>(
      `SELECT b.gl_account_id,b.currency FROM bank_accounts b JOIN companies c ON c.id=b.company_id WHERE b.company_id=? AND b.deleted_at IS NULL AND b.currency<>c.base_currency`,
      [companyId],
    )
    for (const line of lines) {
      const foreignBank = foreignBanks.find((bank) => Number(bank.gl_account_id) === line.accountId)
      if (
        foreignBank &&
        (line.currencyCode !== foreignBank.currency ||
          line.currencyDebit === undefined ||
          line.currencyCredit === undefined)
      )
        throw new ValidationError(
          'Rekening valas wajib memiliki rincian nominal valuta asal. Gunakan transfer atau pelunasan valas dari modul sumber.',
        )
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
      currencyDebit: normalizeDecimal(line.currencyDebit ?? line.debit),
      currencyCredit: normalizeDecimal(line.currencyCredit ?? line.credit),
      currencyCode: line.currencyCode ?? null,
      exchangeRate: normalizeDecimal(line.exchangeRate ?? normalizedRate, 8),
    }))
  }

  async createPostedJournal(connection: QueryExecutor, input: SourceJournalInput) {
    const needed = input.sourceType === 'sales_invoice' ? ['AR_CONTROL','REVENUE','INVENTORY','COGS'] : input.sourceType === 'purchase_invoice' ? ['AP_CONTROL','INVENTORY','PURCHASE_EXPENSE'] : []
    await new AccountMappingService().ensureReadyFor(connection,input.companyId,needed as import('./AccountMappingService').AccountMappingKey[])
    if (['year_end_closing', 'year_end_retained_earnings'].includes(input.sourceType))
      await this.validation.ensureClosedPeriod(connection, input.companyId, input.date)
    else await this.validation.ensureOpenPeriod(connection, input.companyId, input.date)
    const existing = await this.journals.findPostedSource(
      connection,
      input.companyId,
      input.sourceType,
      input.sourceId,
    )
    if (existing) throw new ConflictError('Transaksi sudah pernah diposting')

    const [policyCompany]=await connection.execute<RowDataPacket[]>('SELECT base_currency FROM companies WHERE id=?',[input.companyId])
    const journalCurrency=input.currency ?? String(policyCompany[0]!.base_currency)
    await validateFxPolicy(connection,input.companyId,journalCurrency,input.date,String(input.exchangeRate ?? '1'))
    const totals = await this.validateLines(connection, input.companyId, input.lines)
    const number = await this.sequences.next(connection, input.companyId, 'journal', input.date)
    const journalId = await this.journals.create(connection, {
      companyId: input.companyId,
      number,
      date: input.date,
      reference: input.reference,
      description: input.description,
      currency: journalCurrency,
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
      if (journal.status !== JOURNAL_STATUS.APPROVED && !(await prepareDirectPosting(connection,companyId,'journals',id,String(journal.status),context.userId))) {
        throw new ConflictError('Hanya jurnal yang sudah disetujui dapat diposting')
      }

      const date = this.dateOnly(journal.journal_date)
      await this.validation.ensureOpenPeriod(connection, companyId, date)
      await validateFxPolicy(connection,companyId,String(journal.currency),date,String(journal.exchange_rate))
      const lines = await this.journals.lines(connection, id)
      if (!journal.source_type) await assertManualAccounts(connection, companyId, lines.map(line => Number(line.account_id)))
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
      if (journal.source_type === 'opening_balance') {
        await connection.execute(
          "UPDATE opening_balance_batches SET status='posted',posted_by=?,posted_at=NOW(),version=version+1 WHERE company_id=? AND journal_id=?",
          [context.userId, companyId, id],
        )
      }
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

    const [payrollLinks] = await connection.query<RowDataPacket[]>(
      `SELECT r.id FROM payroll_entry_components c JOIN payroll_entries e ON e.id=c.entry_id JOIN payroll_runs r ON r.id=e.run_id WHERE c.source_journal_id=? AND r.company_id=? AND r.status IN ('approved','posted','paid','locked') LIMIT 1`,
      [original.id,input.companyId],
    )
    if (payrollLinks.length) throw new ConflictError('Jurnal sumber sudah dipakai payroll yang disetujui. Selesaikan koreksi payroll sebelum pembalikan sumber.')

    if ((input.sourceType ?? '').startsWith('year_end_'))
      await this.validation.ensureClosedPeriod(connection, input.companyId, input.date)
    else await this.validation.ensureOpenPeriod(connection, input.companyId, input.date)
    const originalLines = await this.journals.lines(connection, input.journalId)
    const reversalLines: JournalLineInput[] = originalLines.map((line) => ({
      accountId: Number(line.account_id),
      description: `Reversal: ${input.reason}`,
      costCenterId: line.cost_center_id ? Number(line.cost_center_id) : null,
      projectId: line.project_id ? Number(line.project_id) : null,
      debit: line.credit,
      credit: line.debit,
      currencyDebit: line.currency_credit,
      currencyCredit: line.currency_debit,
      currencyCode: line.currency_code,
      exchangeRate: line.exchange_rate,
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
    if (original.source_type === 'opening_balance') {
      await connection.execute(
        "UPDATE opening_balance_batches SET status='reversed',reversal_journal_id=?,reversed_by=?,reversed_at=NOW(),version=version+1 WHERE company_id=? AND journal_id=?",
        [reversalId, input.context.userId, input.companyId, original.id],
      )
    }
    await this.audit.log(connection, {
      ...this.auditInput(input.companyId, input.context, 'reverse', original.id),
      newValue: { status: 'reversed', reversalJournalId: reversalId, reason: input.reason },
    })
    return reversalId
  }

  async reverseManual(input: ReverseJournalInput) {
    return transaction(async (connection) => {
      const [rows] = await connection.execute<import('mysql2/promise').RowDataPacket[]>(
        'SELECT source_type FROM journals WHERE id=? AND company_id=? FOR UPDATE',
        [input.journalId, input.companyId],
      )
      if (['currency_transfer', 'currency_revaluation'].includes(rows[0]?.source_type))
        throw new ConflictError(
          'Balikkan transaksi melalui menu Mata Uang & Transfer agar saldo rekening ikut diperbarui',
        )
      return this.reversePostedJournal(connection, input)
    })
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
