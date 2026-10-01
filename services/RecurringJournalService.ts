import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { z } from 'zod'
import { db, transaction } from '../config/database'
import { JournalRepository } from '../repositories/JournalRepository'
import type { QueryExecutor } from '../types/database'
import { ConflictError, NotFoundError } from '../utils/AppError'
import type {
  recurringJournalSchema,
  recurringJournalUpdateSchema,
} from '../validators/recurring-journal.validator'
import { AuditService } from './AuditService'
import { BusinessValidationService } from './BusinessValidationService'
import { JournalService } from './JournalService'
import { NumberSequenceService } from './NumberSequenceService'
import { PostingService, type PostingContext } from './PostingService'

type RecurringInput = z.infer<typeof recurringJournalSchema>
type RecurringUpdateInput = z.infer<typeof recurringJournalUpdateSchema>
type Frequency = RecurringInput['frequency']
type IntervalUnit = NonNullable<RecurringInput['interval_unit']>

type RecurringRow = RowDataPacket & {
  id: number
  company_id: number
  template_number: string
  name: string
  frequency: Frequency
  interval_value: number
  interval_unit: IntervalUnit | null
  start_date: Date | string
  next_run_date: Date | string
  end_date: Date | string | null
  currency: string
  exchange_rate: string | number
  auto_submit: number | boolean
  is_active: number | boolean
  version: number
}

const dateOnly = (value: Date | string) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)

const utcDate = (value: string) => {
  const result = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(result.getTime())) throw new ConflictError('Tanggal jadwal tidak valid')
  return result
}

const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month + 1, 0)).getUTCDate()

export function nextRecurringDate(
  currentDate: string,
  startDate: string,
  frequency: Frequency,
  intervalValue = 1,
  intervalUnit: IntervalUnit | null = null,
) {
  const current = utcDate(currentDate)
  const anchor = utcDate(startDate)
  const value = Math.max(1, Number(intervalValue) || 1)
  const unit =
    frequency === 'monthly'
      ? 'month'
      : frequency === 'quarterly'
        ? 'month'
        : frequency === 'yearly'
          ? 'year'
          : intervalUnit
  const step = frequency === 'quarterly' ? 3 * value : value

  if (unit === 'day' || unit === 'week') {
    current.setUTCDate(current.getUTCDate() + step * (unit === 'week' ? 7 : 1))
    return current.toISOString().slice(0, 10)
  }

  const monthStep = unit === 'year' ? step * 12 : step
  const absoluteMonth = current.getUTCFullYear() * 12 + current.getUTCMonth() + monthStep
  const targetYear = Math.floor(absoluteMonth / 12)
  const targetMonth = absoluteMonth % 12
  const targetDay = Math.min(anchor.getUTCDate(), daysInMonth(targetYear, targetMonth))
  return new Date(Date.UTC(targetYear, targetMonth, targetDay)).toISOString().slice(0, 10)
}

export class RecurringJournalService {
  constructor(
    private journals = new JournalRepository(),
    private journalService = new JournalService(),
    private posting = new PostingService(),
    private sequences = new NumberSequenceService(),
    private validation = new BusinessValidationService(),
    private audit = new AuditService(),
  ) {}

  async overview(companyId: number) {
    const [templates] = await db.execute<RecurringRow[]>(
      `SELECT r.*,
         COALESCE((SELECT SUM(l.debit) FROM recurring_journal_lines l WHERE l.recurring_journal_id=r.id),0) total_debit,
         (SELECT COUNT(*) FROM recurring_journal_runs x WHERE x.recurring_journal_id=r.id) run_count,
         (SELECT j.journal_number FROM recurring_journal_runs x
           INNER JOIN journals j ON j.id=x.generated_journal_id
           WHERE x.recurring_journal_id=r.id ORDER BY x.scheduled_date DESC LIMIT 1) last_journal_number,
         (SELECT x.scheduled_date FROM recurring_journal_runs x
           WHERE x.recurring_journal_id=r.id ORDER BY x.scheduled_date DESC LIMIT 1) last_scheduled_date
       FROM recurring_journals r
       WHERE r.company_id=? AND r.deleted_at IS NULL
       ORDER BY r.is_active DESC,r.next_run_date,r.name`,
      [companyId],
    )
    const ids = templates.map((item) => Number(item.id))
    let lines: RowDataPacket[] = []
    if (ids.length) {
      const marks = ids.map(() => '?').join(',')
      const [rows] = await db.execute<RowDataPacket[]>(
        `SELECT l.*,a.code account_code,a.name account_name
         FROM recurring_journal_lines l
         INNER JOIN accounts a ON a.id=l.account_id
         WHERE l.recurring_journal_id IN (${marks}) ORDER BY l.recurring_journal_id,l.line_number`,
        ids,
      )
      lines = rows
    }
    const today = new Date().toISOString().slice(0, 10)
    return templates.map((item) => ({
      ...item,
      start_date: dateOnly(item.start_date),
      next_run_date: dateOnly(item.next_run_date),
      end_date: item.end_date ? dateOnly(item.end_date) : null,
      last_scheduled_date: item.last_scheduled_date
        ? dateOnly(item.last_scheduled_date as Date | string)
        : null,
      is_due: Boolean(item.is_active) && dateOnly(item.next_run_date) <= today,
      lines: lines.filter((line) => Number(line.recurring_journal_id) === Number(item.id)),
    }))
  }

  create(companyId: number, input: RecurringInput, context: PostingContext) {
    return transaction(async (connection) => {
      await this.posting.validateLines(connection, companyId, input.lines)
      const number = await this.sequences.next(
        connection,
        companyId,
        'recurring_journal',
        input.start_date,
      )
      const [created] = await connection.execute<ResultSetHeader>(
        `INSERT INTO recurring_journals(
           company_id,template_number,name,description,reference,frequency,interval_value,
           interval_unit,start_date,next_run_date,end_date,currency,exchange_rate,auto_submit,created_by
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          companyId,
          number,
          input.name,
          input.description ?? null,
          input.reference ?? null,
          input.frequency,
          input.frequency === 'custom' ? input.interval_value : 1,
          input.frequency === 'custom' ? (input.interval_unit ?? null) : null,
          input.start_date,
          input.start_date,
          input.end_date ?? null,
          input.currency,
          input.exchange_rate,
          input.auto_submit,
          context.userId,
        ],
      )
      await this.replaceLines(connection, created.insertId, input.lines)
      await this.log(connection, companyId, context, 'create', created.insertId, {
        templateNumber: number,
        name: input.name,
      })
      return { id: created.insertId, templateNumber: number }
    })
  }

  update(companyId: number, id: number, input: RecurringUpdateInput, context: PostingContext) {
    return transaction(async (connection) => {
      const template = await this.template(connection, companyId, id, true)
      if (Number(template.version) !== input.version)
        throw new ConflictError('Jadwal telah diubah pengguna lain. Muat ulang data')
      await this.posting.validateLines(connection, companyId, input.lines)
      const nextRun =
        dateOnly(template.next_run_date) < input.start_date
          ? input.start_date
          : dateOnly(template.next_run_date)
      const remainsActive =
        Boolean(template.is_active) && (!input.end_date || nextRun <= input.end_date)
      const [updated] = await connection.execute<ResultSetHeader>(
        `UPDATE recurring_journals SET name=?,description=?,reference=?,frequency=?,
           interval_value=?,interval_unit=?,start_date=?,next_run_date=?,end_date=?,currency=?,
           exchange_rate=?,auto_submit=?,is_active=?,updated_by=?,version=version+1
         WHERE id=? AND company_id=? AND version=?`,
        [
          input.name,
          input.description ?? null,
          input.reference ?? null,
          input.frequency,
          input.frequency === 'custom' ? input.interval_value : 1,
          input.frequency === 'custom' ? (input.interval_unit ?? null) : null,
          input.start_date,
          nextRun,
          input.end_date ?? null,
          input.currency,
          input.exchange_rate,
          input.auto_submit,
          remainsActive,
          context.userId,
          id,
          companyId,
          input.version,
        ],
      )
      if (!updated.affectedRows) throw new ConflictError('Jadwal gagal diperbarui')
      await this.replaceLines(connection, id, input.lines)
      await this.log(connection, companyId, context, 'update', id, { name: input.name })
      return { id, version: input.version + 1 }
    })
  }

  setActive(companyId: number, id: number, active: boolean, context: PostingContext) {
    return transaction(async (connection) => {
      const template = await this.template(connection, companyId, id, true)
      if (
        active &&
        template.end_date &&
        dateOnly(template.next_run_date) > dateOnly(template.end_date)
      )
        throw new ConflictError('Jadwal sudah melewati tanggal selesai dan tidak dapat diaktifkan')
      await connection.execute(
        'UPDATE recurring_journals SET is_active=?,updated_by=?,version=version+1 WHERE id=? AND company_id=?',
        [active, context.userId, id, companyId],
      )
      await this.log(connection, companyId, context, active ? 'activate' : 'deactivate', id, {
        active,
      })
      return { id, isActive: active }
    })
  }

  generate(companyId: number, id: number, asOfDate: string, context: PostingContext) {
    return transaction((connection) =>
      this.generateInTransaction(connection, companyId, id, asOfDate, context),
    )
  }

  async generateDue(companyId: number, asOfDate: string, context: PostingContext) {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT id FROM recurring_journals
       WHERE company_id=? AND is_active=TRUE AND deleted_at IS NULL AND next_run_date<=?
       ORDER BY next_run_date,id`,
      [companyId, asOfDate],
    )
    const generated: unknown[] = []
    const failed: Array<{ id: number; message: string }> = []
    for (const row of rows) {
      let attempts = 0
      try {
        while (attempts < 120) {
          const result = await this.generate(companyId, Number(row.id), asOfDate, context)
          generated.push(result)
          attempts += 1
          if (!result.isActive || result.nextRunDate > asOfDate) break
        }
        if (attempts === 120)
          failed.push({ id: Number(row.id), message: 'Batas 120 periode tercapai' })
      } catch (error) {
        failed.push({
          id: Number(row.id),
          message: error instanceof Error ? error.message : 'Gagal membuat jurnal',
        })
      }
    }
    return { generated, failed }
  }

  private async generateInTransaction(
    connection: QueryExecutor,
    companyId: number,
    id: number,
    asOfDate: string,
    context: PostingContext,
  ) {
    const template = await this.template(connection, companyId, id, true)
    if (!template.is_active) throw new ConflictError('Jadwal jurnal sedang tidak aktif')
    const scheduledDate = dateOnly(template.next_run_date)
    if (scheduledDate > asOfDate)
      throw new ConflictError(`Jurnal berikutnya baru jatuh tempo ${scheduledDate}`)
    if (template.end_date && scheduledDate > dateOnly(template.end_date))
      throw new ConflictError('Jadwal jurnal sudah melewati tanggal selesai')
    await this.validation.ensureOpenPeriod(connection, companyId, scheduledDate)
    const [existing] = await connection.execute<RowDataPacket[]>(
      `SELECT id,generated_journal_id FROM recurring_journal_runs
       WHERE recurring_journal_id=? AND scheduled_date=? FOR UPDATE`,
      [id, scheduledDate],
    )
    if (existing[0]) throw new ConflictError('Jadwal tanggal ini sudah pernah dibuat')
    const [lineRows] = await connection.execute<RowDataPacket[]>(
      'SELECT * FROM recurring_journal_lines WHERE recurring_journal_id=? ORDER BY line_number',
      [id],
    )
    const lines = lineRows.map((line) => ({
      accountId: Number(line.account_id),
      description: line.description ? String(line.description) : null,
      costCenterId: line.cost_center_id ? Number(line.cost_center_id) : null,
      projectId: line.project_id ? Number(line.project_id) : null,
      debit: String(line.debit),
      credit: String(line.credit),
    }))
    const totals = await this.posting.validateLines(connection, companyId, lines)
    const journalNumber = await this.sequences.next(connection, companyId, 'journal', scheduledDate)
    const journalId = await this.journals.create(connection, {
      companyId,
      number: journalNumber,
      date: scheduledDate,
      reference: template.reference ?? template.template_number,
      description: template.description ?? template.name,
      currency: template.currency,
      exchangeRate: String(template.exchange_rate),
      sourceType: 'recurring_journal',
      sourceId: id,
      status: 'draft',
      userId: context.userId,
      totalDebit: totals.totalDebit,
      totalCredit: totals.totalCredit,
      lines: this.posting.toJournalLines(lines, String(template.exchange_rate)),
    })
    if (template.auto_submit)
      await this.journalService.submitInTransaction(connection, journalId, companyId, context)
    await connection.execute(
      `INSERT INTO recurring_journal_runs(
         recurring_journal_id,scheduled_date,generated_journal_id,generated_by
       ) VALUES(?,?,?,?)`,
      [id, scheduledDate, journalId, context.userId],
    )
    const nextRunDate = nextRecurringDate(
      scheduledDate,
      dateOnly(template.start_date),
      template.frequency,
      Number(template.interval_value),
      template.interval_unit,
    )
    const isActive = !template.end_date || nextRunDate <= dateOnly(template.end_date)
    await connection.execute(
      `UPDATE recurring_journals SET next_run_date=?,is_active=?,last_generated_at=NOW(),
         updated_by=?,version=version+1 WHERE id=?`,
      [nextRunDate, isActive, context.userId, id],
    )
    await this.log(connection, companyId, context, 'generate', id, {
      scheduledDate,
      journalId,
      journalNumber,
      status: template.auto_submit ? 'pending_approval' : 'draft',
    })
    return { id, scheduledDate, journalId, journalNumber, nextRunDate, isActive }
  }

  private async replaceLines(
    connection: QueryExecutor,
    id: number,
    lines: RecurringInput['lines'],
  ) {
    await connection.execute('DELETE FROM recurring_journal_lines WHERE recurring_journal_id=?', [
      id,
    ])
    for (const [index, line] of lines.entries())
      await connection.execute(
        `INSERT INTO recurring_journal_lines(
           recurring_journal_id,line_number,account_id,description,cost_center_id,project_id,debit,credit
         ) VALUES(?,?,?,?,?,?,?,?)`,
        [
          id,
          index + 1,
          line.accountId,
          line.description ?? null,
          line.costCenterId ?? null,
          line.projectId ?? null,
          line.debit,
          line.credit,
        ],
      )
  }

  private async template(connection: QueryExecutor, companyId: number, id: number, lock = false) {
    const [rows] = await connection.execute<RecurringRow[]>(
      `SELECT * FROM recurring_journals
       WHERE id=? AND company_id=? AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
      [id, companyId],
    )
    if (!rows[0]) throw new NotFoundError('Jadwal jurnal tidak ditemukan')
    return rows[0]
  }

  private log(
    connection: QueryExecutor,
    companyId: number,
    context: PostingContext,
    action: string,
    recordId: number,
    newValue: Record<string, unknown>,
  ) {
    return this.audit.log(connection, {
      companyId,
      userId: context.userId,
      module: 'recurring-journal',
      action,
      recordType: 'recurring_journal',
      recordId,
      newValue,
      requestId: context.requestId,
      ip: context.ip,
    })
  }
}
