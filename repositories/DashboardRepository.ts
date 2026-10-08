import type { RowDataPacket } from 'mysql2'

import { db } from '../config/database'

export interface DashboardSummary {
  customers: number
  suppliers: number
  items: number
  postedJournals: number
  receivables: number
  payables: number
  inventoryValue: number
  bankBalance: number
  workQueue: {
    overdueInvoices: number
    receivablesDueThisWeek: number
    payablesDueThisWeek: number
    pendingApprovals: number
    unmatchedBankLines: number
    openTaxPeriods: number
    lowStockItems: number
    unfinishedPayroll: number
    periodsToClose: number
    missingDepreciation: number
    approvedUnposted: number
  }
  monthly: Array<{ month: string; sales: number; purchases: number }>
  recentJournals: Array<{
    id: number
    number: string
    date: string
    description: string
    amount: number
    status: string
  }>
}

interface DashboardSummaryRow extends RowDataPacket {
  customers: number
  suppliers: number
  items: number
  postedJournals: number
  receivables: string | number
  payables: string | number
  inventoryValue: string | number
  bankBalance: string | number
}

export class DashboardRepository {
  async summary(companyId: number): Promise<DashboardSummary> {
    const [rows] = await db.execute<DashboardSummaryRow[]>(
      `SELECT
         (SELECT COUNT(*) FROM customers WHERE company_id = ?) AS customers,
         (SELECT COUNT(*) FROM suppliers WHERE company_id = ?) AS suppliers,
         (SELECT COUNT(*) FROM items WHERE company_id = ?) AS items,
         (
           SELECT COUNT(*)
           FROM journals
           WHERE company_id = ? AND status = 'posted'
         ) AS postedJournals,
         (SELECT COALESCE(SUM(outstanding_amount * exchange_rate), 0) FROM sales_invoices
          WHERE company_id = ? AND status IN ('posted', 'partially_paid')) AS receivables,
         (SELECT COALESCE(SUM(outstanding_amount * exchange_rate), 0) FROM purchase_invoices
          WHERE company_id = ? AND status IN ('posted', 'partially_paid')) AS payables,
         (SELECT COALESCE(SUM(total_value), 0) FROM inventory_balances WHERE company_id = ?) AS inventoryValue,
         (SELECT COALESCE(SUM(current_balance), 0) FROM bank_accounts
          WHERE company_id = ? AND is_active = TRUE AND deleted_at IS NULL) AS bankBalance`,
      [companyId, companyId, companyId, companyId, companyId, companyId, companyId, companyId],
    )

    const [monthlyRows] = await db.execute<RowDataPacket[]>(
      `SELECT month_key AS month, SUM(sales) AS sales, SUM(purchases) AS purchases
       FROM (
         SELECT DATE_FORMAT(invoice_date, '%Y-%m') AS month_key, SUM(base_grand_total) AS sales, 0 AS purchases
         FROM sales_invoices
         WHERE company_id = ? AND status IN ('posted', 'partially_paid', 'paid')
           AND invoice_date >= DATE_SUB(DATE_FORMAT(DATE(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+07:00')), '%Y-%m-01'), INTERVAL 5 MONTH)
         GROUP BY DATE_FORMAT(invoice_date, '%Y-%m')
         UNION ALL
         SELECT DATE_FORMAT(invoice_date, '%Y-%m') AS month_key, 0 AS sales, SUM(base_grand_total) AS purchases
         FROM purchase_invoices
         WHERE company_id = ? AND status IN ('posted', 'partially_paid', 'paid')
           AND invoice_date >= DATE_SUB(DATE_FORMAT(DATE(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+07:00')), '%Y-%m-01'), INTERVAL 5 MONTH)
         GROUP BY DATE_FORMAT(invoice_date, '%Y-%m')
       ) activity
       GROUP BY month_key
       ORDER BY month_key`,
      [companyId, companyId],
    )
    const [workRows] = await db.execute<RowDataPacket[]>(
      `SELECT
        (SELECT COUNT(*) FROM sales_invoices WHERE company_id=? AND status IN ('posted','partially_paid') AND outstanding_amount>0 AND due_date<DATE(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+07:00'))) overdueInvoices,
        (SELECT COUNT(*) FROM sales_invoices WHERE company_id=? AND status IN ('posted','partially_paid') AND outstanding_amount>0 AND due_date BETWEEN DATE(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+07:00')) AND DATE_ADD(DATE(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+07:00')), INTERVAL 7 DAY)) receivablesDueThisWeek,
        (SELECT COUNT(*) FROM purchase_invoices WHERE company_id=? AND status IN ('posted','partially_paid') AND outstanding_amount>0 AND due_date BETWEEN DATE(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+07:00')) AND DATE_ADD(DATE(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+07:00')), INTERVAL 7 DAY)) payablesDueThisWeek,
        (SELECT COUNT(*) FROM approval_requests WHERE company_id=? AND status='pending') pendingApprovals,
        (SELECT COUNT(*) FROM bank_statement_lines l JOIN bank_statements s ON s.id=l.bank_statement_id WHERE s.company_id=? AND l.reconciliation_status IN ('unmatched','partial')) unmatchedBankLines,
        (SELECT COUNT(*) FROM tax_reconciliation_periods WHERE company_id=? AND status<>'locked') openTaxPeriods,
        (SELECT COUNT(*) FROM items i LEFT JOIN (SELECT company_id,item_id,SUM(quantity) quantity FROM inventory_balances GROUP BY company_id,item_id) b ON b.company_id=i.company_id AND b.item_id=i.id WHERE i.company_id=? AND i.item_type='inventory' AND i.is_active=TRUE AND i.deleted_at IS NULL AND i.minimum_stock>0 AND COALESCE(b.quantity,0)<i.minimum_stock) lowStockItems,
        (SELECT COUNT(*) FROM payroll_runs WHERE company_id=? AND period=DATE_FORMAT(DATE(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+07:00')),'%Y-%m') AND status<>'locked') unfinishedPayroll,
        (SELECT COUNT(*) FROM accounting_periods WHERE company_id=? AND status IN('open','soft_closed') AND end_date<DATE(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+07:00'))) periodsToClose`,
      [
        companyId,
        companyId,
        companyId,
        companyId,
        companyId,
        companyId,
        companyId,
        companyId,
        companyId,
      ],
    )
    const [journalRows] = await db.execute<RowDataPacket[]>(
      `SELECT id, journal_number, journal_date, description, total_debit, status
       FROM journals WHERE company_id = ?
       ORDER BY journal_date DESC, id DESC LIMIT 6`,
      [companyId],
    )
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' })
    const [extraWork] = await db.execute<RowDataPacket[]>(
      `SELECT (SELECT COUNT(*) FROM journals WHERE company_id=? AND status='approved' AND journal_date<=?) approved_unposted,
       (SELECT COUNT(*) FROM fixed_assets a WHERE a.company_id=? AND a.deleted_at IS NULL AND a.status='active' AND a.in_service_date<=LAST_DAY(DATE_SUB(?,INTERVAL 1 MONTH))
       AND COALESCE((SELECT SUM(d.depreciation_amount) FROM asset_depreciations d WHERE d.company_id=a.company_id AND d.fixed_asset_id=a.id AND d.status='posted'),0)<a.purchase_cost-a.salvage_value
       AND NOT EXISTS(SELECT 1 FROM asset_depreciations d WHERE d.company_id=a.company_id AND d.fixed_asset_id=a.id AND d.status='posted' AND DATE_FORMAT(d.depreciation_date,'%Y-%m')=DATE_FORMAT(DATE_SUB(?,INTERVAL 1 MONTH),'%Y-%m'))) missing_depreciation`,
      [companyId, today, companyId, today, today],
    )

    const row = rows[0],
      work = workRows[0]

    return {
      customers: Number(row?.customers ?? 0),
      suppliers: Number(row?.suppliers ?? 0),
      items: Number(row?.items ?? 0),
      postedJournals: Number(row?.postedJournals ?? 0),
      receivables: Number(row?.receivables ?? 0),
      payables: Number(row?.payables ?? 0),
      inventoryValue: Number(row?.inventoryValue ?? 0),
      bankBalance: Number(row?.bankBalance ?? 0),
      workQueue: {
        overdueInvoices: Number(work?.overdueInvoices ?? 0),
        receivablesDueThisWeek: Number(work?.receivablesDueThisWeek ?? 0),
        payablesDueThisWeek: Number(work?.payablesDueThisWeek ?? 0),
        pendingApprovals: Number(work?.pendingApprovals ?? 0),
        unmatchedBankLines: Number(work?.unmatchedBankLines ?? 0),
        openTaxPeriods: Number(work?.openTaxPeriods ?? 0),
        lowStockItems: Number(work?.lowStockItems ?? 0),
        unfinishedPayroll: Number(work?.unfinishedPayroll ?? 0),
        periodsToClose: Number(work?.periodsToClose ?? 0),
        missingDepreciation: Number(extraWork[0]?.missing_depreciation ?? 0),
        approvedUnposted: Number(extraWork[0]?.approved_unposted ?? 0),
      },
      monthly: monthlyRows.map((entry) => ({
        month: String(entry.month),
        sales: Number(entry.sales ?? 0),
        purchases: Number(entry.purchases ?? 0),
      })),
      recentJournals: journalRows.map((entry) => ({
        id: Number(entry.id),
        number: String(entry.journal_number),
        date:
          entry.journal_date instanceof Date
            ? entry.journal_date.toISOString().slice(0, 10)
            : String(entry.journal_date).slice(0, 10),
        description: String(entry.description ?? ''),
        amount: Number(entry.total_debit ?? 0),
        status: String(entry.status),
      })),
    }
  }
}
