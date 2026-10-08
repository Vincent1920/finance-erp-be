import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { z } from 'zod'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'
import { db, transaction } from '../config/database'
import { JournalRepository } from '../repositories/JournalRepository'
import type { QueryExecutor } from '../types/database'
import { ConflictError, NotFoundError, ValidationError } from '../utils/AppError'
import {
  fromScaledInteger,
  subtractDecimal,
  toScaledInteger,
  compareDecimal,
} from '../utils/decimal'
import type {
  accountingScheduleSchema,
  scheduleReconcileSchema,
} from '../validators/accounting-schedule.validator'
import { AuditService } from './AuditService'
import { BusinessValidationService } from './BusinessValidationService'
import { JournalService } from './JournalService'
import { NumberSequenceService } from './NumberSequenceService'
import { PostingService, type PostingContext } from './PostingService'

type ScheduleInput = z.infer<typeof accountingScheduleSchema>
type ReconcileInput = Omit<z.infer<typeof scheduleReconcileSchema>, 'source_mode'> & {
  source_mode?: 'observation' | 'expense_after_reversal' | 'variance_adjustment'
}

const dateOnly = (value: Date | string) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)
const monthDate = (start: string, offset: number) => {
  const anchor = new Date(`${start}T00:00:00.000Z`)
  const absolute = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + offset
  const year = Math.floor(absolute / 12),
    month = absolute % 12
  const day = Math.min(anchor.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate())
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10)
}
const firstNextMonth = (date: string) => {
  const value = new Date(`${date}T00:00:00.000Z`)
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1))
    .toISOString()
    .slice(0, 10)
}

const ATTACHMENT_LIMIT = 10 * 1024 * 1024
const allowedAttachments = new Map([
  ['application/pdf', '.pdf'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['text/csv', '.csv'],
])

export function splitScheduleAmount(total: string | number, periods: number) {
  const cents = toScaledInteger(total, 2)
  const count = BigInt(periods)
  const base = cents / count,
    remainder = cents % count
  return Array.from({ length: periods }, (_, index) =>
    fromScaledInteger(base + (BigInt(index) < remainder ? 1n : 0n), 2),
  )
}

export class AccountingScheduleService {
  constructor(
    private journals = new JournalRepository(),
    private journalService = new JournalService(),
    private posting = new PostingService(),
    private sequences = new NumberSequenceService(),
    private validation = new BusinessValidationService(),
    private audit = new AuditService(),
  ) {}

  async overview(companyId: number) {
    const [schedules] = await db.execute<RowDataPacket[]>(
      `SELECT s.*,p.code pnl_account_code,p.name pnl_account_name,b.code balance_account_code,b.name balance_account_name,
        (SELECT COUNT(*) FROM accounting_schedule_entries e WHERE e.schedule_id=s.id AND e.status<>'cancelled') entry_count,
        (SELECT COUNT(*) FROM accounting_schedule_entries e WHERE e.schedule_id=s.id AND e.recognition_journal_id IS NOT NULL) generated_count,
        (SELECT COALESCE(SUM(e.variance_amount),0) FROM accounting_schedule_entries e WHERE e.schedule_id=s.id AND e.actual_amount IS NOT NULL) total_variance
       FROM accounting_schedules s JOIN accounts p ON p.id=s.pnl_account_id JOIN accounts b ON b.id=s.balance_sheet_account_id
       WHERE s.company_id=? AND s.deleted_at IS NULL ORDER BY s.status='active' DESC,s.start_date DESC,s.id DESC`,
      [companyId],
    )
    const ids = schedules.map((row) => Number(row.id))
    let entries: RowDataPacket[] = []
    if (ids.length) {
      const marks = ids.map(() => '?').join(',')
      const [rows] = await db.execute<RowDataPacket[]>(
        `SELECT e.*,r.journal_number recognition_journal_number,r.status recognition_journal_status,
          v.journal_number reversal_journal_number,v.status reversal_journal_status,a.journal_number actual_journal_number,a.status actual_journal_status
         FROM accounting_schedule_entries e
         LEFT JOIN journals r ON r.id=e.recognition_journal_id LEFT JOIN journals v ON v.id=e.reversal_journal_id
         LEFT JOIN journals a ON a.id=e.actual_journal_id WHERE e.schedule_id IN (${marks}) ORDER BY e.schedule_id,e.period_number`,
        ids,
      )
      entries = rows
    }
    const entryIds = entries.map((entry) => Number(entry.id))
    let attachments: RowDataPacket[] = []
    if (entryIds.length) {
      const marks = entryIds.map(() => '?').join(',')
      const [rows] = await db.execute<RowDataPacket[]>(
        `SELECT id,entity_id,original_name,mime_type,file_size,created_at
         FROM attachments WHERE company_id=? AND entity_type='accounting_schedule_entry'
           AND entity_id IN (${marks}) AND deleted_at IS NULL ORDER BY created_at DESC`,
        [companyId, ...entryIds],
      )
      attachments = rows
    }
    return schedules.map((schedule) => ({
      ...schedule,
      start_date: dateOnly(schedule.start_date as Date | string),
      end_date: dateOnly(schedule.end_date as Date | string),
      entries: entries
        .filter((entry) => Number(entry.schedule_id) === Number(schedule.id))
        .map((entry) => ({
          ...entry,
          actual_verified:
            Boolean(entry.actual_verified) &&
            entry.actual_journal_status === 'posted' &&
            entry.recognition_journal_status === 'posted' &&
            (!schedule.auto_reverse || entry.reversal_journal_status === 'posted'),
          scheduled_date: dateOnly(entry.scheduled_date as Date | string),
          is_material_variance:
            entry.actual_amount !== null &&
            Math.abs(Number(entry.variance_amount ?? 0)) >
              Number(schedule.materiality_threshold ?? 0),
          attachments: attachments.filter(
            (attachment) => Number(attachment.entity_id) === Number(entry.id),
          ),
        })),
    }))
  }

  async templates(companyId: number) {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT t.*,p.code pnl_account_code,p.name pnl_account_name,b.code balance_account_code,b.name balance_account_name
       FROM accounting_schedule_templates t JOIN accounts p ON p.id=t.pnl_account_id JOIN accounts b ON b.id=t.balance_sheet_account_id
       WHERE t.company_id=? AND t.is_active=TRUE ORDER BY t.name`,
      [companyId],
    )
    return rows
  }

  async alerts(companyId: number, asOfDate: string) {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT e.id,e.scheduled_date,e.estimated_amount,e.actual_amount,e.variance_amount,s.schedule_number,s.name,s.schedule_type,s.materiality_threshold,
        CASE WHEN e.status='scheduled' AND e.scheduled_date<? THEN 'overdue'
             WHEN e.status='scheduled' AND e.scheduled_date<=? THEN 'due'
             WHEN e.actual_amount IS NOT NULL AND ABS(e.variance_amount)>s.materiality_threshold THEN 'material_variance'
             WHEN e.recognition_journal_id IS NOT NULL AND (e.actual_verified=FALSE OR NOT EXISTS(SELECT 1 FROM journals actual WHERE actual.id=e.actual_journal_id AND actual.status='posted')) AND e.scheduled_date<=? THEN 'unreconciled'
        END alert_type,
        GREATEST(DATEDIFF(?,e.scheduled_date),0) overdue_days
       FROM accounting_schedule_entries e JOIN accounting_schedules s ON s.id=e.schedule_id
       WHERE e.company_id=? AND s.status<>'cancelled' AND (
         (e.status='scheduled' AND e.scheduled_date<=?) OR
         (e.actual_amount IS NOT NULL AND ABS(e.variance_amount)>s.materiality_threshold) OR
         (e.recognition_journal_id IS NOT NULL AND (e.actual_verified=FALSE OR NOT EXISTS(SELECT 1 FROM journals actual WHERE actual.id=e.actual_journal_id AND actual.status='posted')) AND e.scheduled_date<=?)
       ) ORDER BY FIELD(alert_type,'overdue','due','material_variance','unreconciled'),e.scheduled_date`,
      [asOfDate, asOfDate, asOfDate, asOfDate, companyId, asOfDate, asOfDate],
    )
    return rows.map((row) => ({
      ...row,
      scheduled_date: dateOnly(row.scheduled_date as Date | string),
    }))
  }

  create(companyId: number, input: ScheduleInput, context: PostingContext) {
    return transaction(async (connection) => {
      await this.validateAccounts(connection, companyId, input)
      const number = await this.sequences.next(
        connection,
        companyId,
        'accounting_schedule',
        input.start_date,
      )
      const endDate = monthDate(input.start_date, input.periods_count - 1)
      const [created] = await connection.execute<ResultSetHeader>(
        `INSERT INTO accounting_schedules(company_id,schedule_number,schedule_type,name,description,reference,start_date,end_date,periods_count,total_estimated_amount,materiality_threshold,pnl_account_id,balance_sheet_account_id,auto_reverse,auto_submit,created_by)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          companyId,
          number,
          input.schedule_type,
          input.name,
          input.description ?? null,
          input.reference ?? null,
          input.start_date,
          endDate,
          input.periods_count,
          input.total_estimated_amount,
          input.materiality_threshold,
          input.pnl_account_id,
          input.balance_sheet_account_id,
          input.schedule_type === 'accrual' && input.auto_reverse,
          input.auto_submit,
          context.userId,
        ],
      )
      const amounts = splitScheduleAmount(input.total_estimated_amount, input.periods_count)
      for (let index = 0; index < amounts.length; index++)
        await connection.execute(
          `INSERT INTO accounting_schedule_entries(company_id,schedule_id,period_number,scheduled_date,estimated_amount) VALUES(?,?,?,?,?)`,
          [
            companyId,
            created.insertId,
            index + 1,
            monthDate(input.start_date, index),
            amounts[index],
          ],
        )
      if (input.save_as_template)
        await connection.execute(
          `INSERT INTO accounting_schedule_templates(company_id,name,schedule_type,description,periods_count,default_amount,materiality_threshold,pnl_account_id,balance_sheet_account_id,auto_reverse,auto_submit,created_by)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE schedule_type=VALUES(schedule_type),description=VALUES(description),periods_count=VALUES(periods_count),default_amount=VALUES(default_amount),materiality_threshold=VALUES(materiality_threshold),pnl_account_id=VALUES(pnl_account_id),balance_sheet_account_id=VALUES(balance_sheet_account_id),auto_reverse=VALUES(auto_reverse),auto_submit=VALUES(auto_submit),is_active=TRUE`,
          [
            companyId,
            input.template_name ?? input.name,
            input.schedule_type,
            input.description ?? null,
            input.periods_count,
            input.total_estimated_amount,
            input.materiality_threshold,
            input.pnl_account_id,
            input.balance_sheet_account_id,
            input.schedule_type === 'accrual' && input.auto_reverse,
            input.auto_submit,
            context.userId,
          ],
        )
      await this.log(connection, companyId, context, 'create', created.insertId, {
        scheduleNumber: number,
        periods: input.periods_count,
      })
      return { id: created.insertId, scheduleNumber: number }
    })
  }

  async generateDue(companyId: number, asOfDate: string, context: PostingContext) {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT e.id FROM accounting_schedule_entries e JOIN accounting_schedules s ON s.id=e.schedule_id
       WHERE e.company_id=? AND s.status='active' AND e.status='scheduled' AND e.scheduled_date<=? ORDER BY e.scheduled_date,e.id`,
      [companyId, asOfDate],
    )
    const generated: unknown[] = [],
      failed: Array<{ id: number; message: string }> = []
    for (const row of rows)
      try {
        generated.push(await this.generate(companyId, Number(row.id), context))
      } catch (error) {
        failed.push({
          id: Number(row.id),
          message: error instanceof Error ? error.message : 'Gagal membuat jurnal',
        })
      }
    return { generated, failed }
  }

  generate(companyId: number, entryId: number, context: PostingContext) {
    return transaction(async (connection) => {
      const entry = await this.entry(connection, companyId, entryId, true)
      if (entry.schedule_status !== 'active' || entry.status !== 'scheduled')
        throw new ConflictError('Periode jadwal ini tidak dapat diproses')
      const scheduledDate = dateOnly(entry.scheduled_date)
      await this.validation.ensureOpenPeriod(connection, companyId, scheduledDate)
      const [company] = await connection.execute<RowDataPacket[]>(
        'SELECT base_currency FROM companies WHERE id=?',
        [companyId],
      )
      const amount = String(entry.estimated_amount)
      const lines = [
        {
          accountId: Number(entry.pnl_account_id),
          description: entry.name,
          debit: amount,
          credit: '0',
        },
        {
          accountId: Number(entry.balance_sheet_account_id),
          description: entry.name,
          debit: '0',
          credit: amount,
        },
      ]
      const totals = await this.posting.validateLines(connection, companyId, lines)
      const journalNumber = await this.sequences.next(
        connection,
        companyId,
        'journal',
        scheduledDate,
      )
      const journalId = await this.journals.create(connection, {
        companyId,
        number: journalNumber,
        date: scheduledDate,
        reference: entry.reference ?? entry.schedule_number,
        description: `${entry.schedule_type === 'accrual' ? 'Akrual' : 'Amortisasi'}: ${entry.name}`,
        currency: company[0]!.base_currency,
        exchangeRate: '1',
        sourceType: 'accounting_schedule',
        sourceId: entryId,
        status: 'draft',
        userId: context.userId,
        totalDebit: totals.totalDebit,
        totalCredit: totals.totalCredit,
        lines: this.posting.toJournalLines(lines),
      })
      if (entry.auto_submit)
        await this.journalService.submitInTransaction(connection, journalId, companyId, context)
      await connection.execute(
        `UPDATE accounting_schedule_entries SET recognition_journal_id=?,status='generated',generated_by=?,generated_at=NOW() WHERE id=?`,
        [journalId, context.userId, entryId],
      )
      await this.completeIfDone(connection, Number(entry.schedule_id))
      await this.log(connection, companyId, context, 'generate', Number(entry.schedule_id), {
        entryId,
        journalId,
      })
      return { entryId, journalId, journalNumber }
    })
  }

  async processReversals(companyId: number, asOfDate: string, context: PostingContext) {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT e.id FROM accounting_schedule_entries e JOIN accounting_schedules s ON s.id=e.schedule_id JOIN journals j ON j.id=e.recognition_journal_id
       WHERE e.company_id=? AND s.auto_reverse=TRUE AND s.schedule_type='accrual' AND e.reversal_journal_id IS NULL AND j.status='posted' AND e.scheduled_date<=? ORDER BY e.scheduled_date,e.id`,
      [companyId, asOfDate],
    )
    const generated: unknown[] = [],
      failed: Array<{ id: number; message: string }> = []
    for (const row of rows)
      try {
        generated.push(await this.reverse(companyId, Number(row.id), context))
      } catch (error) {
        failed.push({
          id: Number(row.id),
          message: error instanceof Error ? error.message : 'Gagal membuat pembalikan',
        })
      }
    return { generated, failed }
  }

  reverse(companyId: number, entryId: number, context: PostingContext) {
    return transaction(async (connection) => {
      const entry = await this.entry(connection, companyId, entryId, true)
      if (!entry.auto_reverse || entry.schedule_type !== 'accrual')
        throw new ConflictError('Pembalikan otomatis tidak aktif untuk jadwal ini')
      if (entry.reversal_journal_id) throw new ConflictError('Jurnal pembalikan sudah dibuat')
      if (!entry.recognition_journal_id || entry.recognition_journal_status !== 'posted')
        throw new ConflictError('Jurnal akrual harus diposting sebelum dibalik')
      const date = firstNextMonth(dateOnly(entry.scheduled_date))
      await this.validation.ensureOpenPeriod(connection, companyId, date)
      const [company] = await connection.execute<RowDataPacket[]>(
        'SELECT base_currency FROM companies WHERE id=?',
        [companyId],
      )
      const amount = String(entry.estimated_amount)
      const lines = [
        {
          accountId: Number(entry.balance_sheet_account_id),
          description: `Pembalikan ${entry.name}`,
          debit: amount,
          credit: '0',
        },
        {
          accountId: Number(entry.pnl_account_id),
          description: `Pembalikan ${entry.name}`,
          debit: '0',
          credit: amount,
        },
      ]
      const totals = await this.posting.validateLines(connection, companyId, lines)
      const number = await this.sequences.next(connection, companyId, 'journal', date)
      const journalId = await this.journals.create(connection, {
        companyId,
        number,
        date,
        reference: entry.schedule_number,
        description: `Pembalikan akrual: ${entry.name}`,
        currency: company[0]!.base_currency,
        exchangeRate: '1',
        sourceType: 'accounting_schedule_reversal',
        sourceId: entryId,
        status: 'draft',
        userId: context.userId,
        totalDebit: totals.totalDebit,
        totalCredit: totals.totalCredit,
        originalJournalId: Number(entry.recognition_journal_id),
        lines: this.posting.toJournalLines(lines),
      })
      if (entry.auto_submit)
        await this.journalService.submitInTransaction(connection, journalId, companyId, context)
      await connection.execute(
        'UPDATE accounting_schedule_entries SET reversal_journal_id=? WHERE id=?',
        [journalId, entryId],
      )
      await this.log(connection, companyId, context, 'reverse', Number(entry.schedule_id), {
        entryId,
        journalId,
      })
      return { entryId, journalId, journalNumber: number, reversalDate: date }
    })
  }

  reconcile(companyId: number, entryId: number, input: ReconcileInput, context: PostingContext) {
    return transaction(async (connection) => {
      const entry = await this.entry(connection, companyId, entryId, true)
      if (entry.recognition_journal_status !== 'posted')
        throw new ConflictError('Jurnal pengakuan harus diposting sebelum nilai aktual dicatat')
      const variance = subtractDecimal(input.actual_amount, entry.estimated_amount)
      let journalId: number | null = null,
        lineId: number | null = null,
        verified = false
      if ((input.source_mode ?? 'observation') !== 'observation') {
        if (!input.actual_line_id)
          throw new ValidationError('Pilih baris jurnal sumber untuk memverifikasi aktual')
        const [sources] = await connection.execute<RowDataPacket[]>(
          `SELECT l.*,j.status,j.journal_date,j.reference,j.source_type FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE l.id=? AND j.company_id=? FOR UPDATE`,
          [input.actual_line_id, companyId],
        )
        const source = sources[0]
        if (
          !source ||
          source.status !== 'posted' ||
          Number(source.account_id) !== Number(entry.pnl_account_id)
        )
          throw new ValidationError('Sumber aktual wajib jurnal posted pada akun beban jadwal')
        if (
          Number(source.journal_id) === Number(entry.recognition_journal_id) ||
          Number(source.journal_id) === Number(entry.reversal_journal_id)
        )
          throw new ValidationError('Jurnal estimasi/pembalik tidak boleh menjadi bukti aktual')
        if (input.actual_journal_id && Number(source.journal_id) !== input.actual_journal_id)
          throw new ValidationError('Baris sumber tidak sesuai jurnal aktual')
        if (dateOnly(source.journal_date) < dateOnly(entry.scheduled_date))
          throw new ValidationError('Tanggal jurnal aktual tidak boleh sebelum pengakuan estimasi')
        const [used] = await connection.execute<RowDataPacket[]>(
          'SELECT id FROM accounting_schedule_entries WHERE company_id=? AND actual_line_id=? AND id<>? AND actual_verified=TRUE FOR UPDATE',
          [companyId, input.actual_line_id, entryId],
        )
        if (used.length)
          throw new ConflictError(
            'Baris jurnal aktual sudah dipakai periode jadwal lain; gunakan baris terpisah',
          )
        const net = subtractDecimal(source.debit, source.credit)
        if (input.source_mode === 'expense_after_reversal') {
          if (entry.schedule_type !== 'accrual' || !entry.auto_reverse)
            throw new ValidationError('Beban aktual penuh hanya untuk akrual dengan pembalikan')
          const [reversals] = await connection.execute<RowDataPacket[]>(
            'SELECT status,journal_date FROM journals WHERE id=? AND company_id=? FOR UPDATE',
            [entry.reversal_journal_id ?? 0, companyId],
          )
          if (
            reversals[0]?.status !== 'posted' ||
            dateOnly(source.journal_date) < dateOnly(reversals[0].journal_date)
          )
            throw new ConflictError(
              'Posting pembalikan akrual dahulu sebelum mencocokkan beban aktual penuh',
            )
          if (compareDecimal(net, input.actual_amount) !== 0)
            throw new ValidationError(
              'Nilai aktual harus sama dengan debit bersih baris beban sumber',
            )
        } else {
          if (entry.auto_reverse)
            throw new ValidationError(
              'Gunakan beban aktual setelah pembalikan untuk jadwal auto-reverse',
            )
          if (compareDecimal(net, variance) !== 0)
            throw new ValidationError(
              'Jurnal koreksi harus mencatat selisih aktual terhadap estimasi saja',
            )
          const [balance] = await connection.execute<RowDataPacket[]>(
            'SELECT COALESCE(SUM(credit-debit),0) net FROM journal_lines WHERE journal_id=? AND account_id=?',
            [source.journal_id, entry.balance_sheet_account_id],
          )
          if (compareDecimal(balance[0]!.net, variance) !== 0)
            throw new ValidationError(
              'Lawan jurnal koreksi harus akun neraca jadwal dengan nilai selisih yang sama',
            )
        }
        journalId = Number(source.journal_id)
        lineId = Number(source.id)
        verified = true
      }
      await connection.execute(
        `UPDATE accounting_schedule_entries SET actual_amount=?,variance_amount=?,actual_reference=?,actual_journal_id=?,actual_line_id=?,actual_verified=?,status=?,reconciled_by=?,reconciled_at=NOW() WHERE id=?`,
        [
          input.actual_amount,
          variance,
          input.actual_reference ?? null,
          journalId,
          lineId,
          verified,
          verified ? 'reconciled' : 'generated',
          context.userId,
          entryId,
        ],
      )
      await this.log(connection, companyId, context, 'reconcile', Number(entry.schedule_id), {
        entryId,
        actualAmount: input.actual_amount,
        variance,
      })
      return { entryId, variance, verified, journalId }
    })
  }

  async actualSources(companyId: number, entryId: number) {
    const entry = await this.entry(db, companyId, entryId)
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT l.id line_id,l.journal_id,j.journal_number,j.journal_date,j.reference,j.source_type,l.description,l.debit,l.credit,(l.debit-l.credit) net_amount FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.company_id=? AND j.status='posted' AND l.account_id=? AND j.journal_date>=? AND j.id NOT IN (?,?) AND NOT EXISTS(SELECT 1 FROM accounting_schedule_entries e WHERE e.company_id=? AND e.actual_line_id=l.id AND e.actual_verified=TRUE AND e.id<>?) ORDER BY j.journal_date DESC,l.id DESC LIMIT 500`,
      [
        companyId,
        entry.pnl_account_id,
        dateOnly(entry.scheduled_date),
        entry.recognition_journal_id ?? 0,
        entry.reversal_journal_id ?? 0,
        companyId,
        entryId,
      ],
    )
    return rows
  }
  adjustment(
    companyId: number,
    entryId: number,
    input: { date: string; actual_amount: number; reference: string },
    context: PostingContext,
  ) {
    return transaction(async (c) => {
      const entry = await this.entry(c, companyId, entryId, true)
      if (entry.auto_reverse)
        throw new ValidationError(
          'Jadwal auto-reverse memakai beban aktual penuh setelah pembalikan, bukan koreksi selisih',
        )
      if (entry.recognition_journal_status !== 'posted')
        throw new ConflictError('Posting pengakuan estimasi terlebih dahulu')
      if (input.date < dateOnly(entry.scheduled_date))
        throw new ValidationError('Tanggal koreksi tidak boleh sebelum pengakuan estimasi')
      await this.validation.ensureOpenPeriod(c, companyId, input.date)
      const delta = subtractDecimal(input.actual_amount, entry.estimated_amount)
      if (compareDecimal(delta, 0) === 0)
        throw new ValidationError('Tidak ada selisih yang perlu dijurnal')
      const positive = compareDecimal(delta, 0) > 0,
        amount = positive ? delta : subtractDecimal(0, delta)
      const [existing] = await c.execute<RowDataPacket[]>(
        "SELECT id,status,total_debit,journal_date,reference FROM journals WHERE company_id=? AND source_type='accounting_schedule_adjustment' AND source_id=? ORDER BY id DESC LIMIT 1",
        [companyId, entryId],
      )
      if (existing[0]) {
        const [net] = await c.execute<RowDataPacket[]>(
          'SELECT COALESCE(SUM(debit-credit),0) amount FROM journal_lines WHERE journal_id=? AND account_id=?',
          [existing[0].id, entry.pnl_account_id],
        )
        if (
          existing[0].status === 'draft' &&
          compareDecimal(existing[0].total_debit, amount) === 0 &&
          compareDecimal(net[0]!.amount, delta) === 0 &&
          dateOnly(existing[0].journal_date) === input.date &&
          existing[0].reference === input.reference
        )
          return { journalId: Number(existing[0].id), reused: true }
        throw new ConflictError(
          'Jurnal koreksi sudah tersedia untuk periode ini. Tinjau jurnal tersebut sebelum membuat perubahan lain.',
        )
      }
      const lines = [
        {
          accountId: Number(entry.pnl_account_id),
          debit: positive ? amount : '0',
          credit: positive ? '0' : amount,
        },
        {
          accountId: Number(entry.balance_sheet_account_id),
          debit: positive ? '0' : amount,
          credit: positive ? amount : '0',
        },
      ]
      const totals = await this.posting.validateLines(c, companyId, lines)
      const [company] = await c.execute<RowDataPacket[]>(
        'SELECT base_currency FROM companies WHERE id=?',
        [companyId],
      )
      const journalId = await this.journals.create(c, {
        companyId,
        number: await this.sequences.next(c, companyId, 'journal', input.date),
        date: input.date,
        reference: input.reference,
        description: `Koreksi aktual ${entry.name}`,
        currency: company[0]!.base_currency,
        exchangeRate: '1',
        sourceType: 'accounting_schedule_adjustment',
        sourceId: entryId,
        status: 'draft',
        userId: context.userId,
        ...totals,
        lines: this.posting.toJournalLines(lines),
      })
      await this.log(c, companyId, context, 'generate', Number(entry.schedule_id), {
        entryId,
        actualAmount: input.actual_amount,
        variance: delta,
        journalId,
      })
      return { journalId, reused: false }
    })
  }

  async uploadAttachment(companyId: number, entryId: number, file: File, context: PostingContext) {
    if (!file.size || file.size > ATTACHMENT_LIMIT)
      throw new ValidationError('Ukuran lampiran harus lebih dari 0 dan maksimal 10 MB')
    const extension = allowedAttachments.get(file.type)
    if (!extension) throw new ValidationError('Lampiran harus PDF, JPG, PNG, XLSX, atau CSV')
    await this.entry(db, companyId, entryId)
    const bytes = Buffer.from(await file.arrayBuffer())
    const checksum = createHash('sha256').update(bytes).digest('hex')
    const directory = resolve(process.cwd(), 'storage', 'attachments', String(companyId))
    await mkdir(directory, { recursive: true })
    const fileName = `${randomUUID()}${extension}`
    const absolutePath = resolve(directory, fileName)
    await writeFile(absolutePath, bytes)
    const storagePath = relative(process.cwd(), absolutePath).replaceAll('\\', '/')
    const [created] = await db.execute<ResultSetHeader>(
      `INSERT INTO attachments(company_id,entity_type,entity_id,category,file_name,original_name,mime_type,file_extension,file_size,storage_disk,storage_path,checksum,uploaded_by)
       VALUES(?,'accounting_schedule_entry',?,'supporting_document',?,?,?,?,?,'local',?,?,?)`,
      [
        companyId,
        entryId,
        fileName,
        file.name.slice(0, 255),
        file.type,
        extname(fileName).slice(1),
        file.size,
        storagePath,
        checksum,
        context.userId,
      ],
    )
    return {
      id: created.insertId,
      entity_id: entryId,
      original_name: file.name,
      mime_type: file.type,
      file_size: file.size,
    }
  }

  async attachment(companyId: number, attachmentId: number) {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT * FROM attachments WHERE id=? AND company_id=? AND entity_type='accounting_schedule_entry' AND deleted_at IS NULL`,
      [attachmentId, companyId],
    )
    const attachment = rows[0] as
      | (RowDataPacket & {
          original_name: string
          mime_type: string
          storage_path: string
        })
      | undefined
    if (!attachment) throw new NotFoundError('Lampiran tidak ditemukan')
    const root = resolve(process.cwd(), 'storage', 'attachments')
    const path = resolve(process.cwd(), String(attachment.storage_path))
    if (relative(root, path).startsWith('..'))
      throw new ConflictError('Lokasi lampiran tidak valid')
    return { ...attachment, path }
  }

  async removeAttachment(companyId: number, attachmentId: number, context: PostingContext) {
    const attachment = await this.attachment(companyId, attachmentId)
    await db.execute(
      'UPDATE attachments SET deleted_at=NOW(),deleted_by=? WHERE id=? AND company_id=?',
      [context.userId, attachmentId, companyId],
    )
    return { id: attachmentId, name: attachment.original_name }
  }

  private async validateAccounts(
    connection: QueryExecutor,
    companyId: number,
    input: ScheduleInput,
  ) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT id,account_type,is_posting,is_active FROM accounts WHERE company_id=? AND id IN (?,?)',
      [companyId, input.pnl_account_id, input.balance_sheet_account_id],
    )
    const pnl = rows.find((row) => Number(row.id) === input.pnl_account_id),
      balance = rows.find((row) => Number(row.id) === input.balance_sheet_account_id)
    if (
      !pnl ||
      !pnl.is_posting ||
      !pnl.is_active ||
      !['expense', 'cogs', 'other_expense'].includes(String(pnl.account_type))
    )
      throw new ValidationError('Akun pengakuan harus akun beban aktif yang dapat diposting')
    const expected = input.schedule_type === 'accrual' ? 'liability' : 'asset'
    if (!balance || !balance.is_posting || !balance.is_active || balance.account_type !== expected)
      throw new ValidationError(
        `Akun neraca untuk ${input.schedule_type === 'accrual' ? 'akrual harus liabilitas' : 'biaya dibayar di muka harus aset'}`,
      )
  }
  private async entry(connection: QueryExecutor, companyId: number, id: number, lock = false) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT e.*,s.schedule_number,s.schedule_type,s.name,s.reference,s.pnl_account_id,s.balance_sheet_account_id,s.auto_reverse,s.auto_submit,s.status schedule_status,j.status recognition_journal_status FROM accounting_schedule_entries e JOIN accounting_schedules s ON s.id=e.schedule_id LEFT JOIN journals j ON j.id=e.recognition_journal_id WHERE e.id=? AND e.company_id=? ${lock ? 'FOR UPDATE' : ''}`,
      [id, companyId],
    )
    if (!rows[0]) throw new NotFoundError('Periode jadwal tidak ditemukan')
    return rows[0]
  }
  private async completeIfDone(connection: QueryExecutor, scheduleId: number) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT COUNT(*) remaining FROM accounting_schedule_entries WHERE schedule_id=? AND status='scheduled'`,
      [scheduleId],
    )
    if (Number(rows[0]?.remaining ?? 0) === 0)
      await connection.execute(`UPDATE accounting_schedules SET status='completed' WHERE id=?`, [
        scheduleId,
      ])
  }
  private log(
    connection: QueryExecutor,
    companyId: number,
    context: PostingContext,
    action: string,
    id: number,
    value: unknown,
  ) {
    return this.audit.log(connection, {
      companyId,
      userId: context.userId,
      module: 'accounting',
      action,
      recordType: 'accounting_schedule',
      recordId: id,
      newValue: value,
      requestId: context.requestId,
      ip: context.ip,
    })
  }
}
