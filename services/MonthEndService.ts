import type { RowDataPacket } from 'mysql2/promise'
import { db } from '../config/database'
import { NotFoundError } from '../utils/AppError'

const dateOnly = (value: Date | string) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)

export class MonthEndService {
  async dashboard(companyId: number, asOfDate: string) {
    const [periods] = await db.execute<RowDataPacket[]>(
      `SELECT * FROM accounting_periods
       WHERE company_id=? AND ? BETWEEN start_date AND end_date LIMIT 1`,
      [companyId, asOfDate],
    )
    const period = periods[0]
    if (!period) throw new NotFoundError('Periode akuntansi untuk tanggal tersebut belum dibuat')
    const start = dateOnly(period.start_date as Date | string)
    const end = dateOnly(period.end_date as Date | string)

    const [[journals], [recurring], [depreciation], [bank], [latestRun]] = await Promise.all([
      db.execute<RowDataPacket[]>(
        `SELECT
           SUM(status='draft') draft_count,
           SUM(status='pending_approval') pending_count,
           SUM(status='approved') approved_count
         FROM journals WHERE company_id=? AND journal_date BETWEEN ? AND ?`,
        [companyId, start, end],
      ),
      db.execute<RowDataPacket[]>(
        `SELECT COUNT(*) due_count FROM recurring_journals
         WHERE company_id=? AND is_active=TRUE AND deleted_at IS NULL AND next_run_date<=?`,
        [companyId, end],
      ),
      db.execute<RowDataPacket[]>(
        `SELECT COUNT(*) missing_count FROM fixed_assets a
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
      ),
      db.execute<RowDataPacket[]>(
        `SELECT
           (SELECT COUNT(*) FROM bank_statement_lines l
             INNER JOIN bank_statements s ON s.id=l.bank_statement_id
             WHERE s.company_id=? AND l.transaction_date BETWEEN ? AND ?
               AND l.reconciliation_status IN('unmatched','partial')) unmatched_count,
           (SELECT COUNT(*) FROM bank_accounts b
             WHERE b.company_id=? AND b.is_active=TRUE AND b.deleted_at IS NULL
               AND NOT EXISTS(
                 SELECT 1 FROM bank_statements s WHERE s.bank_account_id=b.id
                   AND s.company_id=b.company_id AND s.period_start<=? AND s.period_end>=?
               )) missing_statement_count`,
        [companyId, start, end, companyId, end, start],
      ),
      db.execute<RowDataPacket[]>(
        `SELECT r.id,r.status,r.requested_status,r.validated_at,r.completed_at,
           COALESCE((SELECT COUNT(*) FROM period_close_checks c
             WHERE c.period_close_run_id=r.id AND c.is_blocking=TRUE AND c.status='failed'),0) failures
         FROM period_close_runs r WHERE r.accounting_period_id=?
         ORDER BY r.run_number DESC LIMIT 1`,
        [period.id],
      ),
    ])

    const counts = {
      draftJournals: Number(journals[0]?.draft_count ?? 0),
      pendingApprovals: Number(journals[0]?.pending_count ?? 0),
      approvedUnposted: Number(journals[0]?.approved_count ?? 0),
      dueRecurring: Number(recurring[0]?.due_count ?? 0),
      missingDepreciation: Number(depreciation[0]?.missing_count ?? 0),
      unmatchedBankLines: Number(bank[0]?.unmatched_count ?? 0),
      missingBankStatements: Number(bank[0]?.missing_statement_count ?? 0),
    }
    const tasks = [
      {
        code: 'recurring',
        label: 'Proses jurnal berulang',
        count: counts.dueRecurring,
        link: '/accounting/recurring-journals',
      },
      {
        code: 'draft',
        label: 'Selesaikan jurnal draft',
        count: counts.draftJournals,
        link: '/accounting/journals?status=draft',
      },
      {
        code: 'approval',
        label: 'Tinjau jurnal menunggu persetujuan',
        count: counts.pendingApprovals,
        link: '/accounting/journals?status=pending_approval',
      },
      {
        code: 'posting',
        label: 'Posting jurnal yang sudah disetujui',
        count: counts.approvedUnposted,
        link: '/accounting/journals?status=approved',
      },
      {
        code: 'depreciation',
        label: 'Lengkapi penyusutan aset',
        count: counts.missingDepreciation,
        link: '/assets/depreciation',
      },
      {
        code: 'bank',
        label: 'Rekonsiliasi mutasi bank',
        count: counts.unmatchedBankLines + counts.missingBankStatements,
        link: '/banking/reconciliation',
      },
    ]
    const complete = tasks.filter((task) => task.count === 0).length
    return {
      period: {
        id: Number(period.id),
        year: Number(period.year),
        month: Number(period.month),
        startDate: start,
        endDate: end,
        status: String(period.status),
      },
      readinessScore: Math.round((complete / tasks.length) * 100),
      counts,
      tasks,
      latestCloseRun: latestRun[0] ?? null,
    }
  }
}
