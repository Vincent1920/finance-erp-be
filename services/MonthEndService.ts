import type { RowDataPacket } from 'mysql2/promise'
import ExcelJS from 'exceljs'
import { db } from '../config/database'
import { NotFoundError } from '../utils/AppError'
import { ReportingService } from './ReportingService'

const dateOnly = (value: Date | string) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)

export class MonthEndService {
  constructor(private reports = new ReportingService()) {}

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

    const [
      [journals],
      [recurring],
      [schedules],
      [depreciation],
      [bank],
      [latestRun],
      [operations],
      reconciliation,
    ] = await Promise.all([
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
        `SELECT
           SUM(e.status='scheduled' AND e.scheduled_date<=?) due_count,
           SUM(e.recognition_journal_id IS NOT NULL AND (e.actual_verified=FALSE OR NOT EXISTS(SELECT 1 FROM journals actual WHERE actual.id=e.actual_journal_id AND actual.status='posted')) AND e.scheduled_date<=?) unreconciled_count,
           SUM(s.auto_reverse=TRUE AND e.recognition_journal_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM journals v WHERE v.id=e.reversal_journal_id AND v.status='posted') AND r.status='posted' AND e.scheduled_date<=?) pending_reversal_count,
           SUM(e.actual_amount IS NOT NULL AND ABS(e.variance_amount)>s.materiality_threshold AND e.scheduled_date BETWEEN ? AND ?) material_variance_count,
           COALESCE(SUM(CASE WHEN e.actual_amount IS NOT NULL AND e.scheduled_date BETWEEN ? AND ? THEN ABS(e.variance_amount) ELSE 0 END),0) absolute_variance
         FROM accounting_schedule_entries e JOIN accounting_schedules s ON s.id=e.schedule_id
         LEFT JOIN journals r ON r.id=e.recognition_journal_id
         WHERE e.company_id=? AND s.status<>'cancelled'`,
        [end, end, end, start, end, start, end, companyId],
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
      db.execute<RowDataPacket[]>(
        `SELECT
            (SELECT COUNT(*) FROM sales_invoices WHERE company_id=? AND invoice_date BETWEEN ? AND ? AND status IN('draft','approved'))
            +(SELECT COUNT(*) FROM purchase_invoices WHERE company_id=? AND invoice_date BETWEEN ? AND ? AND status IN('draft','approved')) unfinished_documents,
            (SELECT COUNT(*) FROM sales_invoices WHERE company_id=? AND invoice_date BETWEEN ? AND ? AND status='pending_approval')
            +(SELECT COUNT(*) FROM purchase_invoices WHERE company_id=? AND invoice_date BETWEEN ? AND ? AND status='pending_approval') pending_invoice_approvals,
            (SELECT COUNT(*) FROM reconciliation_cases WHERE company_id=? AND as_of_date=? AND status IN('open','in_review')) open_reconciliation_cases,
            (SELECT COUNT(*) FROM tax_reconciliation_periods WHERE company_id=? AND tax_period=? AND status<>'locked') open_tax_periods,
            (SELECT COUNT(*) FROM payroll_runs WHERE company_id=? AND period=? AND status NOT IN('paid','locked')) unfinished_payroll`,
        [
          companyId,
          start,
          end,
          companyId,
          start,
          end,
          companyId,
          start,
          end,
          companyId,
          start,
          end,
          companyId,
          end,
          companyId,
          end.slice(0, 7),
          companyId,
          end.slice(0, 7),
        ],
      ),
      this.reports.subledger(companyId, end),
    ])

    const counts = {
      draftJournals: Number(journals[0]?.draft_count ?? 0),
      pendingApprovals: Number(journals[0]?.pending_count ?? 0),
      approvedUnposted: Number(journals[0]?.approved_count ?? 0),
      dueRecurring: Number(recurring[0]?.due_count ?? 0),
      dueSchedules: Number(schedules[0]?.due_count ?? 0),
      unreconciledSchedules: Number(schedules[0]?.unreconciled_count ?? 0),
      pendingScheduleReversals: Number(schedules[0]?.pending_reversal_count ?? 0),
      materialScheduleVariances: Number(schedules[0]?.material_variance_count ?? 0),
      scheduleVariance: Number(schedules[0]?.absolute_variance ?? 0),
      missingDepreciation: Number(depreciation[0]?.missing_count ?? 0),
      unmatchedBankLines: Number(bank[0]?.unmatched_count ?? 0),
      missingBankStatements: Number(bank[0]?.missing_statement_count ?? 0),
      unfinishedDocuments: Number(operations[0]?.unfinished_documents ?? 0),
      pendingInvoiceApprovals: Number(operations[0]?.pending_invoice_approvals ?? 0),
      openReconciliationCases: Number(operations[0]?.open_reconciliation_cases ?? 0),
      openTaxPeriods: Number(operations[0]?.open_tax_periods ?? 0),
      unfinishedPayroll: Number(operations[0]?.unfinished_payroll ?? 0),
      subledgerDifferences: reconciliation.filter((row) => !row.balanced).length,
    }
    const tasks = [
      {
        code: 'source-documents',
        label: 'Selesaikan invoice draft atau belum diposting',
        count: counts.unfinishedDocuments,
        link: '/transactions',
      },
      {
        code: 'subledger',
        label: 'Rekonsiliasi subledger dengan buku besar',
        count: Math.max(counts.subledgerDifferences, counts.openReconciliationCases),
        link: '/reports/subledger',
      },
      {
        code: 'tax',
        label: 'Tinjau dan kunci rekonsiliasi pajak',
        count: counts.openTaxPeriods,
        link: '/tax/reconciliation',
      },
      {
        code: 'payroll',
        label: 'Selesaikan payroll periode berjalan',
        count: counts.unfinishedPayroll,
        link: '/payroll',
      },
      {
        code: 'schedules',
        label: 'Proses akrual & amortisasi',
        count: counts.dueSchedules,
        link: '/accounting/schedules',
      },
      {
        code: 'schedule-reconciliation',
        label: 'Bandingkan estimasi dengan aktual',
        count: counts.unreconciledSchedules,
        link: '/accounting/schedules',
      },
      {
        code: 'schedule-reversal',
        label: 'Buat pembalikan akrual',
        count: counts.pendingScheduleReversals,
        link: '/accounting/schedules',
      },
      {
        code: 'schedule-materiality',
        label: 'Tinjau selisih material',
        count: counts.materialScheduleVariances,
        link: '/accounting/schedules',
      },
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
        label: 'Tinjau dokumen menunggu persetujuan',
        count: counts.pendingApprovals + counts.pendingInvoiceApprovals,
        link: '/approvals',
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

  async exportPackage(companyId: number, asOfDate: string) {
    const dashboard = await this.dashboard(companyId, asOfDate)
    const [
      [comparisons],
      trialBalance,
      profitLoss,
      balanceSheet,
      cashFlow,
      receivables,
      payables,
      reconciliation,
    ] = await Promise.all([
      db.execute<RowDataPacket[]>(
        `SELECT s.schedule_number,s.schedule_type,s.name,e.period_number,e.scheduled_date,e.estimated_amount,
        e.actual_amount,e.variance_amount,s.materiality_threshold,
        IF(e.actual_amount IS NOT NULL AND ABS(e.variance_amount)>s.materiality_threshold,'Ya','Tidak') material_variance,
        (SELECT COUNT(*) FROM attachments x WHERE x.company_id=e.company_id AND x.entity_type='accounting_schedule_entry' AND x.entity_id=e.id AND x.deleted_at IS NULL) attachment_count,
        e.status,r.journal_number recognition_journal,r.status recognition_status,
        v.journal_number reversal_journal,v.status reversal_status
       FROM accounting_schedule_entries e JOIN accounting_schedules s ON s.id=e.schedule_id
       LEFT JOIN journals r ON r.id=e.recognition_journal_id LEFT JOIN journals v ON v.id=e.reversal_journal_id
       WHERE e.company_id=? AND e.scheduled_date BETWEEN ? AND ? ORDER BY s.schedule_number,e.period_number`,
        [companyId, dashboard.period.startDate, dashboard.period.endDate],
      ),
      this.reports.trialBalance(companyId, {
        dateFrom: dashboard.period.startDate,
        dateTo: dashboard.period.endDate,
      }),
      this.reports.profitLoss(companyId, {
        dateFrom: dashboard.period.startDate,
        dateTo: dashboard.period.endDate,
      }),
      this.reports.balanceSheet(companyId, dashboard.period.endDate),
      this.reports.cashFlow(companyId, {
        dateFrom: dashboard.period.startDate,
        dateTo: dashboard.period.endDate,
      }),
      this.reports.aging(companyId, 'receivable', dashboard.period.endDate),
      this.reports.aging(companyId, 'payable', dashboard.period.endDate),
      this.reports.subledger(companyId, dashboard.period.endDate),
    ])
    const workbook = new ExcelJS.Workbook()
    workbook.creator = 'Finora ERP'
    workbook.created = new Date()
    const summary = workbook.addWorksheet('Ringkasan')
    summary.addRows([
      ['PAKET TUTUP BULAN'],
      ['Periode', `${dashboard.period.startDate} s.d. ${dashboard.period.endDate}`],
      ['Status periode', dashboard.period.status],
      ['Kesiapan', `${dashboard.readinessScore}%`],
      [],
      ['Pemeriksaan', 'Jumlah'],
      ...dashboard.tasks.map((task) => [task.label, task.count]),
    ])
    summary.getColumn(1).width = 42
    summary.getColumn(2).width = 24
    summary.getRow(1).font = { bold: true, size: 16, color: { argb: 'FF1D4ED8' } }
    summary.getRow(6).font = { bold: true }
    const detail = workbook.addWorksheet('Akrual dan Amortisasi')
    detail.columns = [
      ['Nomor', 'schedule_number'],
      ['Tipe', 'schedule_type'],
      ['Nama', 'name'],
      ['Periode', 'period_number'],
      ['Tanggal', 'scheduled_date'],
      ['Estimasi', 'estimated_amount'],
      ['Aktual', 'actual_amount'],
      ['Selisih', 'variance_amount'],
      ['Batas Materialitas', 'materiality_threshold'],
      ['Selisih Material', 'material_variance'],
      ['Jumlah Lampiran', 'attachment_count'],
      ['Status', 'status'],
      ['Jurnal Pengakuan', 'recognition_journal'],
      ['Status Pengakuan', 'recognition_status'],
      ['Jurnal Pembalikan', 'reversal_journal'],
      ['Status Pembalikan', 'reversal_status'],
    ].map(([header, key]) => ({ header, key, width: key === 'name' ? 32 : 18 }))
    comparisons.forEach((row) =>
      detail.addRow({ ...row, scheduled_date: dateOnly(row.scheduled_date as Date | string) }),
    )
    detail.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
    detail.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } }
    detail.views = [{ state: 'frozen', ySplit: 1 }]
    detail.autoFilter = { from: 'A1', to: 'P1' }
    for (const column of ['F', 'G', 'H', 'I'])
      detail.getColumn(column).numFmt = '#,##0.00;[Red]-#,##0.00'
    const [pendingJournals] = await db.execute<RowDataPacket[]>(
      `SELECT journal_number,journal_date,description,source_type,status,total_debit
       FROM journals WHERE company_id=? AND journal_date BETWEEN ? AND ? AND status IN('draft','pending_approval','approved')
       ORDER BY journal_date,journal_number`,
      [companyId, dashboard.period.startDate, dashboard.period.endDate],
    )
    const journals = workbook.addWorksheet('Jurnal Belum Selesai')
    journals.columns = [
      ['Nomor', 'journal_number'],
      ['Tanggal', 'journal_date'],
      ['Keterangan', 'description'],
      ['Sumber', 'source_type'],
      ['Status', 'status'],
      ['Nilai', 'total_debit'],
    ].map(([header, key]) => ({ header, key, width: key === 'description' ? 42 : 20 }))
    pendingJournals.forEach((row) =>
      journals.addRow({ ...row, journal_date: dateOnly(row.journal_date as Date | string) }),
    )
    journals.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
    journals.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } }
    journals.views = [{ state: 'frozen', ySplit: 1 }]
    journals.autoFilter = { from: 'A1', to: 'F1' }
    journals.getColumn('F').numFmt = '#,##0.00'

    const addTable = (
      name: string,
      columns: Array<[string, string, number?]>,
      rows: Array<Record<string, unknown>>,
      moneyColumns: string[] = [],
    ) => {
      const sheet = workbook.addWorksheet(name)
      sheet.columns = columns.map(([header, key, width]) => ({ header, key, width: width ?? 18 }))
      rows.forEach((row) => sheet.addRow(row))
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } }
      sheet.views = [{ state: 'frozen', ySplit: 1 }]
      if (rows.length)
        sheet.autoFilter = { from: 'A1', to: `${sheet.getColumn(columns.length).letter}1` }
      for (const key of moneyColumns) sheet.getColumn(key).numFmt = '#,##0.00;[Red]-#,##0.00'
      return sheet
    }

    addTable(
      'Neraca Saldo',
      [
        ['Nomor Akun', 'code'],
        ['Nama Akun', 'name', 32],
        ['Awal Debit', 'openingDebit'],
        ['Awal Kredit', 'openingCredit'],
        ['Mutasi Debit', 'periodDebit'],
        ['Mutasi Kredit', 'periodCredit'],
        ['Akhir Debit', 'endingDebit'],
        ['Akhir Kredit', 'endingCredit'],
      ],
      trialBalance.accounts as unknown as Array<Record<string, unknown>>,
      [
        'openingDebit',
        'openingCredit',
        'periodDebit',
        'periodCredit',
        'endingDebit',
        'endingCredit',
      ],
    )

    const profitLossRows = Object.entries(profitLoss.sections).flatMap(([section, value]) =>
      value.accounts.map((row) => ({
        section,
        account_code: row.code,
        account_name: row.name,
        amount: Number(row.amount),
      })),
    )
    addTable(
      'Laba Rugi',
      [
        ['Kelompok', 'section'],
        ['Nomor Akun', 'account_code'],
        ['Nama Akun', 'account_name', 34],
        ['Nilai', 'amount'],
      ],
      profitLossRows,
      ['amount'],
    )

    const balanceRows = [
      ...balanceSheet.sections.assets.accounts.map((row) => ({
        section: 'Aset',
        account_code: row.code,
        account_name: row.name,
        amount: Number(row.amount),
      })),
      ...balanceSheet.sections.liabilities.accounts.map((row) => ({
        section: 'Liabilitas',
        account_code: row.code,
        account_name: row.name,
        amount: Number(row.amount),
      })),
      ...balanceSheet.sections.equity.accounts.map((row) => ({
        section: 'Ekuitas',
        account_code: row.code,
        account_name: row.name,
        amount: Number(row.amount),
      })),
      {
        section: 'Ekuitas',
        account_code: '',
        account_name: 'Laba ditahan belum ditutup',
        amount: Number(balanceSheet.sections.equity.unclosedPriorEarnings),
      },
      {
        section: 'Ekuitas',
        account_code: '',
        account_name: 'Laba tahun berjalan',
        amount: Number(balanceSheet.sections.equity.currentYearEarnings),
      },
    ]
    addTable(
      'Neraca',
      [
        ['Kelompok', 'section'],
        ['Nomor Akun', 'account_code'],
        ['Nama Akun', 'account_name', 34],
        ['Nilai', 'amount'],
      ],
      balanceRows,
      ['amount'],
    )

    addTable(
      'Arus Kas',
      [
        ['Keterangan', 'label', 34],
        ['Nilai', 'amount'],
      ],
      [
        { label: 'Saldo awal', amount: Number(cashFlow.openingBalance) },
        { label: 'Aktivitas operasi', amount: Number(cashFlow.activities.operating) },
        { label: 'Aktivitas investasi', amount: Number(cashFlow.activities.investing) },
        { label: 'Aktivitas pendanaan', amount: Number(cashFlow.activities.financing) },
        { label: 'Perubahan bersih', amount: Number(cashFlow.netChange) },
        { label: 'Saldo akhir', amount: Number(cashFlow.endingBalance) },
        { label: 'Selisih rekonsiliasi', amount: Number(cashFlow.difference) },
      ],
      ['amount'],
    )

    const agingColumns: Array<[string, string, number?]> = [
      ['Invoice', 'invoice_number'],
      ['Tanggal', 'invoice_date'],
      ['Jatuh Tempo', 'due_date'],
      ['Kode Mitra', 'party_code'],
      ['Nama Mitra', 'party_name', 30],
      ['Belum Jatuh Tempo', 'current'],
      ['1–30', '1-30'],
      ['31–60', '31-60'],
      ['61–90', '61-90'],
      ['>90', '>90'],
      ['Sisa', 'outstanding_amount'],
    ]
    const agingRows = (rows: Array<Record<string, unknown>>) =>
      rows.map((row) => ({
        ...row,
        current: row.aging_bucket === 'current' ? Number(row.outstanding_amount) : 0,
        '1-30': row.aging_bucket === '1-30' ? Number(row.outstanding_amount) : 0,
        '31-60': row.aging_bucket === '31-60' ? Number(row.outstanding_amount) : 0,
        '61-90': row.aging_bucket === '61-90' ? Number(row.outstanding_amount) : 0,
        '>90': row.aging_bucket === '>90' ? Number(row.outstanding_amount) : 0,
      }))
    addTable(
      'Umur Piutang',
      agingColumns,
      agingRows(receivables.rows as Array<Record<string, unknown>>),
      ['current', '1-30', '31-60', '61-90', '>90', 'outstanding_amount'],
    )
    addTable(
      'Umur Utang',
      agingColumns,
      agingRows(payables.rows as Array<Record<string, unknown>>),
      ['current', '1-30', '31-60', '61-90', '>90', 'outstanding_amount'],
    )

    addTable(
      'Rekonsiliasi Subledger',
      [
        ['Jenis', 'type'],
        ['Nomor Akun', 'accountCode'],
        ['Nama Akun', 'accountName', 30],
        ['Saldo GL', 'generalLedger'],
        ['Saldo Subledger', 'subledger'],
        ['Selisih', 'difference'],
        ['Cocok', 'balanced'],
        ['Status Tindak Lanjut', 'workflowStatus'],
        ['Penanggung Jawab', 'assignedToName', 24],
        ['Target', 'dueDate'],
        ['Catatan', 'resolutionNote', 36],
      ],
      reconciliation as unknown as Array<Record<string, unknown>>,
      ['generalLedger', 'subledger', 'difference'],
    )

    const [ledgerRows] = await db.execute<RowDataPacket[]>(
      `SELECT j.journal_date,j.journal_number,a.code account_code,a.name account_name,j.reference,
              COALESCE(l.description,j.description) description,l.debit,l.credit,j.source_type,j.source_id
         FROM journal_lines l JOIN journals j ON j.id=l.journal_id JOIN accounts a ON a.id=l.account_id
        WHERE j.company_id=? AND j.journal_date BETWEEN ? AND ? AND j.status IN('posted','reversed')
        ORDER BY j.journal_date,j.id,l.id`,
      [companyId, dashboard.period.startDate, dashboard.period.endDate],
    )
    addTable(
      'Buku Besar Periode',
      [
        ['Tanggal', 'journal_date'],
        ['Jurnal', 'journal_number'],
        ['Nomor Akun', 'account_code'],
        ['Nama Akun', 'account_name', 30],
        ['Referensi', 'reference'],
        ['Keterangan', 'description', 36],
        ['Debit', 'debit'],
        ['Kredit', 'credit'],
        ['Sumber', 'source_type'],
      ],
      ledgerRows,
      ['debit', 'credit'],
    )
    const buffer = await workbook.xlsx.writeBuffer()
    return Buffer.from(buffer)
  }
}
