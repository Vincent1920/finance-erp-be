import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { db, transaction } from '../config/database'
import { ReportRepository } from '../repositories/ReportRepository'
import type { QueryExecutor } from '../types/database'
import { ConflictError, NotFoundError } from '../utils/AppError'
import { addDecimal, compareDecimal, subtractDecimal } from '../utils/decimal'
import { AuditService } from './AuditService'
import type { PostingContext } from './PostingService'

type PeriodRow = RowDataPacket & {
  id: number
  company_id: number
  year: number
  month: number
  start_date: Date | string
  end_date: Date | string
  status: 'open' | 'soft_closed' | 'closed'
}

type CloseCheck = {
  code:
    | 'ar_reconciled'
    | 'ap_reconciled'
    | 'inventory_reconciled'
    | 'bank_reconciled'
    | 'depreciation_posted'
    | 'recurring_journals_reviewed'
    | 'trial_balance_balanced'
  status: 'passed' | 'failed'
  isBlocking: boolean
  subledger?: string
  generalLedger?: string
  difference?: string
  details: string
  evidence?: Record<string, unknown>
}

const dateOnly = (value: Date | string) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)

const sum = (values: unknown[]) => addDecimal(values.map((value) => String(value ?? 0)))

export class PeriodClosingService {
  constructor(
    private reports = new ReportRepository(),
    private audit = new AuditService(),
  ) {}

  async overview(companyId: number, year?: number) {
    const conditions = ['p.company_id = ?']
    const values: Array<number> = [companyId]
    if (year) {
      conditions.push('p.year = ?')
      values.push(year)
    }
    const [periods] = await db.execute<RowDataPacket[]>(
      `SELECT p.*,
         r.id latest_run_id,r.run_number,r.requested_status,r.status run_status,
         r.validated_at,r.completed_at,r.notes run_notes,
         COALESCE((SELECT COUNT(*) FROM period_close_checks c
           WHERE c.period_close_run_id=r.id AND c.is_blocking=TRUE AND c.status='failed'),0)
           blocking_failures
       FROM accounting_periods p
       LEFT JOIN period_close_runs r ON r.id=(
         SELECT x.id FROM period_close_runs x
         WHERE x.accounting_period_id=p.id ORDER BY x.run_number DESC LIMIT 1
       )
       WHERE ${conditions.join(' AND ')}
       ORDER BY p.start_date DESC`,
      values,
    )
    const runIds = periods.map((row) => Number(row.latest_run_id)).filter(Boolean)
    let checks: RowDataPacket[] = []
    if (runIds.length) {
      const marks = runIds.map(() => '?').join(',')
      const [rows] = await db.execute<RowDataPacket[]>(
        `SELECT * FROM period_close_checks
         WHERE period_close_run_id IN (${marks})
         ORDER BY period_close_run_id,id`,
        runIds,
      )
      checks = rows
    }
    return periods.map((period) => ({
      ...period,
      start_date: dateOnly(period.start_date as Date | string),
      end_date: dateOnly(period.end_date as Date | string),
      checks: checks.filter(
        (check) => Number(check.period_close_run_id) === Number(period.latest_run_id),
      ),
    }))
  }

  async validate(
    companyId: number,
    input: { period_id: number; requested_status: 'soft_closed' | 'closed'; notes?: string | null },
    context: PostingContext,
  ) {
    const period = await this.period(companyId, input.period_id)
    if (period.status === 'closed') throw new ConflictError('Periode sudah ditutup permanen')
    if (input.requested_status === 'soft_closed' && period.status !== 'open')
      throw new ConflictError('Tutup sementara hanya dapat dilakukan dari periode terbuka')

    const checks = await this.evaluate(companyId, period)
    return transaction(async (connection) => {
      const locked = await this.period(companyId, input.period_id, connection, true)
      if (locked.status === 'closed') throw new ConflictError('Periode sudah ditutup permanen')
      const [sequence] = await connection.execute<RowDataPacket[]>(
        'SELECT COALESCE(MAX(run_number),0)+1 next_number FROM period_close_runs WHERE accounting_period_id=?',
        [period.id],
      )
      const failed = checks.some((check) => check.isBlocking && check.status === 'failed')
      const [created] = await connection.execute<ResultSetHeader>(
        `INSERT INTO period_close_runs(
           company_id,accounting_period_id,run_number,requested_status,status,notes,
           initiated_by,validated_by,validated_at
         ) VALUES(?,?,?,?,?,?,?, ?,NOW())`,
        [
          companyId,
          period.id,
          Number(sequence[0]?.next_number ?? 1),
          input.requested_status,
          failed ? 'failed' : 'validated',
          input.notes ?? null,
          context.userId,
          context.userId,
        ],
      )
      for (const check of checks)
        await connection.execute(
          `INSERT INTO period_close_checks(
             period_close_run_id,check_code,status,is_blocking,subledger_amount,
             general_ledger_amount,difference,evidence,details,checked_by,checked_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,NOW())`,
          [
            created.insertId,
            check.code,
            check.status,
            check.isBlocking,
            check.subledger ?? null,
            check.generalLedger ?? null,
            check.difference ?? null,
            JSON.stringify(check.evidence ?? {}),
            check.details,
            context.userId,
          ],
        )
      await this.audit.log(connection, {
        companyId,
        userId: context.userId,
        module: 'period-closing',
        action: 'validate',
        recordType: 'period_close_run',
        recordId: created.insertId,
        newValue: { periodId: period.id, requestedStatus: input.requested_status, failed },
        requestId: context.requestId,
        ip: context.ip,
      })
      return this.run(connection, companyId, created.insertId)
    })
  }

  async complete(companyId: number, runId: number, context: PostingContext) {
    return transaction(async (connection) => {
      const [runs] = await connection.execute<RowDataPacket[]>(
        `SELECT r.*,p.start_date,p.end_date,p.status period_status
         FROM period_close_runs r
         INNER JOIN accounting_periods p ON p.id=r.accounting_period_id AND p.company_id=r.company_id
         WHERE r.id=? AND r.company_id=? FOR UPDATE`,
        [runId, companyId],
      )
      const run = runs[0]
      if (!run) throw new NotFoundError('Pemeriksaan penutupan tidak ditemukan')
      if (run.status !== 'validated')
        throw new ConflictError('Jalankan pemeriksaan sampai seluruh kontrol wajib lulus')
      const [failed] = await connection.execute<RowDataPacket[]>(
        `SELECT COUNT(*) total FROM period_close_checks
         WHERE period_close_run_id=? AND is_blocking=TRUE AND status<>'passed'`,
        [runId],
      )
      if (Number(failed[0]?.total))
        throw new ConflictError('Masih ada pemeriksaan wajib yang gagal')
      const [changes] = await connection.execute<RowDataPacket[]>(
        `SELECT COUNT(*) total FROM journals
         WHERE company_id=? AND journal_date BETWEEN ? AND ? AND updated_at>?`,
        [companyId, run.start_date, run.end_date, run.validated_at],
      )
      if (Number(changes[0]?.total))
        throw new ConflictError(
          'Ada perubahan jurnal setelah pemeriksaan. Jalankan pemeriksaan ulang',
        )
      if (run.requested_status === 'soft_closed')
        await connection.execute(
          `UPDATE accounting_periods SET status='soft_closed',soft_closed_at=NOW(),
             soft_closed_by=?,close_notes=? WHERE id=? AND company_id=?`,
          [context.userId, run.notes ?? null, run.accounting_period_id, companyId],
        )
      else
        await connection.execute(
          `UPDATE accounting_periods SET status='closed',closed_at=NOW(),closed_by=?,
             close_notes=? WHERE id=? AND company_id=?`,
          [context.userId, run.notes ?? null, run.accounting_period_id, companyId],
        )
      await connection.execute(
        `UPDATE period_close_runs SET status='completed',completed_by=?,completed_at=NOW()
         WHERE id=?`,
        [context.userId, runId],
      )
      await this.audit.log(connection, {
        companyId,
        userId: context.userId,
        module: 'period-closing',
        action: 'complete',
        recordType: 'accounting_period',
        recordId: Number(run.accounting_period_id),
        oldValue: { status: run.period_status },
        newValue: { status: run.requested_status, runId },
        requestId: context.requestId,
        ip: context.ip,
      })
      return { id: Number(run.accounting_period_id), status: run.requested_status }
    })
  }

  async reopen(companyId: number, periodId: number, reason: string, context: PostingContext) {
    return transaction(async (connection) => {
      const period = await this.period(companyId, periodId, connection, true)
      if (period.status === 'open') throw new ConflictError('Periode sudah terbuka')
      const [later] = await connection.execute<RowDataPacket[]>(
        `SELECT id,year,month,status FROM accounting_periods
         WHERE company_id=? AND start_date>? AND status<>'open' ORDER BY start_date LIMIT 1`,
        [companyId, period.end_date],
      )
      if (later[0])
        throw new ConflictError(
          'Buka kembali periode setelahnya terlebih dahulu agar urutan periode tetap konsisten',
        )
      const [yearEnd] = await connection.execute<RowDataPacket[]>(
        `SELECT id FROM year_end_closings
         WHERE company_id=? AND status='posted' AND closing_date BETWEEN ? AND ? LIMIT 1`,
        [companyId, period.start_date, period.end_date],
      )
      if (yearEnd[0])
        throw new ConflictError(
          'Balikkan penutupan tahun terlebih dahulu sebelum membuka periode ini',
        )
      await connection.execute(
        `UPDATE accounting_periods SET status='open',closed_at=NULL,closed_by=NULL,
           soft_closed_at=NULL,soft_closed_by=NULL,reopened_at=NOW(),reopened_by=?,close_notes=?
         WHERE id=? AND company_id=?`,
        [context.userId, reason, periodId, companyId],
      )
      await this.audit.log(connection, {
        companyId,
        userId: context.userId,
        module: 'period-closing',
        action: 'reopen',
        recordType: 'accounting_period',
        recordId: periodId,
        oldValue: { status: period.status },
        newValue: { status: 'open', reason },
        requestId: context.requestId,
        ip: context.ip,
      })
      return { id: periodId, status: 'open' as const }
    })
  }

  private async evaluate(companyId: number, period: PeriodRow): Promise<CloseCheck[]> {
    const end = dateOnly(period.end_date)
    const start = dateOnly(period.start_date)
    const reconciliation = (await this.reports.subledgerReconciliation(
      companyId,
      end,
    )) as RowDataPacket[]
    const reconcileCheck = (type: string, code: CloseCheck['code'], label: string): CloseCheck => {
      const rows = reconciliation.filter((row) => String(row.reconciliation_type) === type)
      const subledger = sum(rows.map((row) => row.subledger))
      const generalLedger = sum(rows.map((row) => row.general_ledger))
      const difference = subtractDecimal(subledger, generalLedger)
      const passed = compareDecimal(difference, '0') === 0
      return {
        code,
        status: passed ? 'passed' : 'failed',
        isBlocking: true,
        subledger,
        generalLedger,
        difference,
        details: passed
          ? `${label} sesuai dengan buku besar.`
          : `${label} belum sesuai dengan buku besar.`,
        evidence: { accounts: rows.length },
      }
    }

    const [depreciation] = await db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) missing
       FROM fixed_assets a
       WHERE a.company_id=? AND a.deleted_at IS NULL AND a.status='active'
         AND a.in_service_date<=?
         AND NOT EXISTS(
           SELECT 1 FROM asset_depreciations d
           WHERE d.fixed_asset_id=a.id AND d.company_id=a.company_id
             AND d.status='posted' AND d.depreciation_date BETWEEN ? AND ?
         )
         AND COALESCE((SELECT SUM(d.depreciation_amount) FROM asset_depreciations d
           WHERE d.fixed_asset_id=a.id AND d.status='posted'),0)<a.purchase_cost-a.salvage_value`,
      [companyId, end, start, end],
    )
    const missingDepreciation = Number(depreciation[0]?.missing ?? 0)

    const [recurring] = await db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) due FROM recurring_journals
       WHERE company_id=? AND is_active=TRUE AND deleted_at IS NULL
         AND next_run_date<=?`,
      [companyId, end],
    )
    const recurringDue = Number(recurring[0]?.due ?? 0)

    const [trial] = await db.execute<RowDataPacket[]>(
      `SELECT COALESCE(SUM(jl.debit),0) debit,COALESCE(SUM(jl.credit),0) credit
       FROM journals j INNER JOIN journal_lines jl ON jl.journal_id=j.id
       WHERE j.company_id=? AND j.status IN('posted','reversed') AND j.journal_date<=?`,
      [companyId, end],
    )
    const [unposted] = await db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) total FROM journals
       WHERE company_id=? AND journal_date BETWEEN ? AND ?
         AND status IN('draft','pending_approval','approved','rejected')`,
      [companyId, start, end],
    )
    const debit = String(trial[0]?.debit ?? 0)
    const credit = String(trial[0]?.credit ?? 0)
    const trialDifference = subtractDecimal(debit, credit)
    const unpostedTotal = Number(unposted[0]?.total ?? 0)
    const trialPassed = compareDecimal(trialDifference, '0') === 0 && unpostedTotal === 0

    return [
      reconcileCheck('ar', 'ar_reconciled', 'Piutang'),
      reconcileCheck('ap', 'ap_reconciled', 'Utang'),
      reconcileCheck('inventory', 'inventory_reconciled', 'Persediaan'),
      reconcileCheck('bank', 'bank_reconciled', 'Saldo bank'),
      {
        code: 'depreciation_posted',
        status: missingDepreciation === 0 ? 'passed' : 'failed',
        isBlocking: true,
        details:
          missingDepreciation === 0
            ? 'Penyusutan aset periode ini sudah lengkap.'
            : `${missingDepreciation} aset belum memiliki penyusutan periode ini.`,
        evidence: { missingAssets: missingDepreciation },
      },
      {
        code: 'recurring_journals_reviewed',
        status: recurringDue === 0 ? 'passed' : 'failed',
        isBlocking: true,
        details:
          recurringDue === 0
            ? 'Tidak ada jurnal berulang yang tertunda.'
            : `${recurringDue} jurnal berulang masih jatuh tempo dan belum diproses.`,
        evidence: { dueTemplates: recurringDue },
      },
      {
        code: 'trial_balance_balanced',
        status: trialPassed ? 'passed' : 'failed',
        isBlocking: true,
        generalLedger: debit,
        subledger: credit,
        difference: trialDifference,
        details: trialPassed
          ? 'Neraca saldo seimbang dan tidak ada jurnal periode yang belum selesai.'
          : `Selisih neraca saldo ${trialDifference}; jurnal belum selesai ${unpostedTotal}.`,
        evidence: { debit, credit, unpostedJournals: unpostedTotal },
      },
    ]
  }

  private async period(
    companyId: number,
    id: number,
    connection: QueryExecutor = db,
    lock = false,
  ) {
    const [rows] = await connection.execute<PeriodRow[]>(
      `SELECT * FROM accounting_periods WHERE id=? AND company_id=? ${lock ? 'FOR UPDATE' : ''}`,
      [id, companyId],
    )
    if (!rows[0]) throw new NotFoundError('Periode akuntansi tidak ditemukan')
    return rows[0]
  }

  private async run(connection: QueryExecutor, companyId: number, id: number) {
    const [runs] = await connection.execute<RowDataPacket[]>(
      'SELECT * FROM period_close_runs WHERE id=? AND company_id=?',
      [id, companyId],
    )
    const [checks] = await connection.execute<RowDataPacket[]>(
      'SELECT * FROM period_close_checks WHERE period_close_run_id=? ORDER BY id',
      [id],
    )
    return { ...runs[0], checks }
  }
}
