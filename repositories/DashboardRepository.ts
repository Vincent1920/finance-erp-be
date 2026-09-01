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
         (SELECT COALESCE(SUM(base_outstanding_amount), 0) FROM sales_invoices
          WHERE company_id = ? AND status IN ('posted', 'partially_paid')) AS receivables,
         (SELECT COALESCE(SUM(base_outstanding_amount), 0) FROM purchase_invoices
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
           AND invoice_date >= DATE_SUB(DATE_FORMAT(CURRENT_DATE, '%Y-%m-01'), INTERVAL 5 MONTH)
         GROUP BY DATE_FORMAT(invoice_date, '%Y-%m')
         UNION ALL
         SELECT DATE_FORMAT(invoice_date, '%Y-%m') AS month_key, 0 AS sales, SUM(base_grand_total) AS purchases
         FROM purchase_invoices
         WHERE company_id = ? AND status IN ('posted', 'partially_paid', 'paid')
           AND invoice_date >= DATE_SUB(DATE_FORMAT(CURRENT_DATE, '%Y-%m-01'), INTERVAL 5 MONTH)
         GROUP BY DATE_FORMAT(invoice_date, '%Y-%m')
       ) activity
       GROUP BY month_key
       ORDER BY month_key`,
      [companyId, companyId],
    )
    const [journalRows] = await db.execute<RowDataPacket[]>(
      `SELECT id, journal_number, journal_date, description, total_debit, status
       FROM journals WHERE company_id = ?
       ORDER BY journal_date DESC, id DESC LIMIT 6`,
      [companyId],
    )

    const row = rows[0]

    return {
      customers: Number(row?.customers ?? 0),
      suppliers: Number(row?.suppliers ?? 0),
      items: Number(row?.items ?? 0),
      postedJournals: Number(row?.postedJournals ?? 0),
      receivables: Number(row?.receivables ?? 0),
      payables: Number(row?.payables ?? 0),
      inventoryValue: Number(row?.inventoryValue ?? 0),
      bankBalance: Number(row?.bankBalance ?? 0),
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
