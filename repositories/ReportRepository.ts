import type { RowDataPacket } from 'mysql2/promise'

import { db } from '../config/database'
import { pagination } from '../utils/pagination'

export interface DateRange {
  dateFrom: string
  dateTo: string
}

export interface LedgerFilters extends DateRange {
  accountId?: number
  costCenterId?: number
  projectId?: number
  reference?: string
  page?: string
  limit?: string
}

export interface TrialBalanceRow extends RowDataPacket {
  id: number
  code: string
  name: string
  account_type: string
  normal_balance: 'debit' | 'credit'
  opening_debit: string | number
  opening_credit: string | number
  period_debit: string | number
  period_credit: string | number
  ending_debit: string | number
  ending_credit: string | number
}

export class ReportRepository {
  async generalLedger(companyId: number, filters: LedgerFilters) {
    const { page, limit, offset } = pagination(filters.page, filters.limit)
    const conditions = ['j.company_id = ?', "j.status = 'posted'", 'j.journal_date BETWEEN ? AND ?']
    const values: Array<string | number> = [companyId, filters.dateFrom, filters.dateTo]
    const openingConditions = ['j.company_id = ?', "j.status = 'posted'", 'j.journal_date < ?']
    const openingValues: Array<string | number> = [companyId, filters.dateFrom]

    if (filters.accountId) {
      conditions.push('jl.account_id = ?')
      openingConditions.push('jl.account_id = ?')
      values.push(filters.accountId)
      openingValues.push(filters.accountId)
    }
    if (filters.costCenterId) {
      conditions.push('jl.cost_center_id = ?')
      openingConditions.push('jl.cost_center_id = ?')
      values.push(filters.costCenterId)
      openingValues.push(filters.costCenterId)
    }
    if (filters.projectId) {
      conditions.push('jl.project_id = ?')
      openingConditions.push('jl.project_id = ?')
      values.push(filters.projectId)
      openingValues.push(filters.projectId)
    }
    if (filters.reference) {
      conditions.push('(j.reference LIKE ? OR j.journal_number LIKE ? OR jl.description LIKE ?)')
      const search = `%${filters.reference}%`
      values.push(search, search, search)
    }

    const [rows] = await db.query<RowDataPacket[]>(
      `WITH opening AS (
         SELECT jl.account_id, COALESCE(SUM(jl.debit - jl.credit), 0) AS balance
         FROM journal_lines jl
         INNER JOIN journals j ON j.id = jl.journal_id
         WHERE ${openingConditions.join(' AND ')}
         GROUP BY jl.account_id
       ), entries AS (
         SELECT
           jl.id,
           jl.account_id,
           a.code AS account_code,
           a.name AS account_name,
           a.normal_balance,
           j.id AS journal_id,
           j.journal_number,
           j.journal_date,
           j.reference,
           j.source_type,
           j.source_id,
           jl.description,
           jl.cost_center_id,
           cc.name AS cost_center_name,
           jl.project_id,
           p.name AS project_name,
           jl.debit,
           jl.credit,
           COALESCE(o.balance, 0) AS opening_balance
         FROM journal_lines jl
         INNER JOIN journals j ON j.id = jl.journal_id
         INNER JOIN accounts a ON a.id = jl.account_id AND a.company_id = j.company_id
         LEFT JOIN opening o ON o.account_id = jl.account_id
         LEFT JOIN cost_centers cc ON cc.id = jl.cost_center_id AND cc.company_id = j.company_id
         LEFT JOIN projects p ON p.id = jl.project_id AND p.company_id = j.company_id
         WHERE ${conditions.join(' AND ')}
       )
       SELECT
         entries.*,
         opening_balance + SUM(debit - credit) OVER (
           PARTITION BY account_id ORDER BY journal_date, journal_id, id
         ) AS running_balance,
         COUNT(*) OVER () AS total_rows
       FROM entries
       ORDER BY account_code, journal_date, journal_id, id
       LIMIT ? OFFSET ?`,
      [...openingValues, ...values, limit, offset],
    )

    return { rows, page, limit, total: Number(rows[0]?.total_rows ?? 0) }
  }

  async trialBalance(companyId: number, range: DateRange): Promise<TrialBalanceRow[]> {
    const [rows] = await db.execute<TrialBalanceRow[]>(
      `WITH balances AS (
         SELECT
           a.id,
           a.code,
           a.name,
           a.account_type,
           a.normal_balance,
           COALESCE(SUM(CASE WHEN j.journal_date < ? THEN jl.debit ELSE 0 END), 0) AS opening_debit,
           COALESCE(SUM(CASE WHEN j.journal_date < ? THEN jl.credit ELSE 0 END), 0) AS opening_credit,
           COALESCE(SUM(CASE WHEN j.journal_date BETWEEN ? AND ? THEN jl.debit ELSE 0 END), 0)
             AS period_debit,
           COALESCE(SUM(CASE WHEN j.journal_date BETWEEN ? AND ? THEN jl.credit ELSE 0 END), 0)
             AS period_credit
         FROM accounts a
         LEFT JOIN journal_lines jl ON jl.account_id = a.id
         LEFT JOIN journals j
           ON j.id = jl.journal_id
          AND j.company_id = a.company_id
          AND j.status = 'posted'
          AND j.journal_date <= ?
         WHERE a.company_id = ?
           AND a.deleted_at IS NULL
           AND a.is_posting = TRUE
         GROUP BY a.id, a.code, a.name, a.account_type, a.normal_balance
       )
       SELECT
         balances.*,
         GREATEST((opening_debit + period_debit) - (opening_credit + period_credit), 0)
           AS ending_debit,
         GREATEST((opening_credit + period_credit) - (opening_debit + period_debit), 0)
           AS ending_credit
       FROM balances
       ORDER BY code`,
      [
        range.dateFrom,
        range.dateFrom,
        range.dateFrom,
        range.dateTo,
        range.dateFrom,
        range.dateTo,
        range.dateTo,
        companyId,
      ],
    )
    return rows
  }

  async accountMovements(companyId: number, range: DateRange) {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT
         a.id,
         a.code,
         a.name,
         a.account_type,
         a.normal_balance,
         COALESCE(SUM(jl.debit), 0) AS debit,
         COALESCE(SUM(jl.credit), 0) AS credit
       FROM accounts a
       LEFT JOIN journal_lines jl ON jl.account_id = a.id
       LEFT JOIN journals j
         ON j.id = jl.journal_id
        AND j.company_id = a.company_id
        AND j.status = 'posted'
        AND j.journal_date BETWEEN ? AND ?
       WHERE a.company_id = ?
         AND a.deleted_at IS NULL
         AND a.is_posting = TRUE
       GROUP BY a.id, a.code, a.name, a.account_type, a.normal_balance
       ORDER BY a.code`,
      [range.dateFrom, range.dateTo, companyId],
    )
    return rows
  }

  async accountBalancesAsOf(companyId: number, asOfDate: string) {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT
         a.id,
         a.code,
         a.name,
         a.account_type,
         a.normal_balance,
         COALESCE(SUM(jl.debit), 0) AS debit,
         COALESCE(SUM(jl.credit), 0) AS credit
       FROM accounts a
       LEFT JOIN journal_lines jl ON jl.account_id = a.id
       LEFT JOIN journals j
         ON j.id = jl.journal_id
        AND j.company_id = a.company_id
        AND j.status = 'posted'
        AND j.journal_date <= ?
       WHERE a.company_id = ?
         AND a.deleted_at IS NULL
         AND a.is_posting = TRUE
       GROUP BY a.id, a.code, a.name, a.account_type, a.normal_balance
       ORDER BY a.code`,
      [asOfDate, companyId],
    )
    return rows
  }

  async cashFlow(companyId: number, range: DateRange) {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT
         CASE
           WHEN j.source_type IN (
             'fixed_asset_acquisition', 'fixed_asset_disposal', 'asset_depreciation'
           ) THEN 'investing'
           WHEN j.source_type IN (
             'capital_contribution', 'dividend', 'loan_receipt', 'loan_payment', 'year_end_closing'
           ) THEN 'financing'
           ELSE 'operating'
         END AS activity,
         COALESCE(SUM(jl.debit - jl.credit), 0) AS amount
       FROM journals j
       INNER JOIN journal_lines jl ON jl.journal_id = j.id
       INNER JOIN accounts a ON a.id = jl.account_id AND a.company_id = j.company_id
       LEFT JOIN bank_accounts ba
         ON ba.gl_account_id = a.id AND ba.company_id = j.company_id AND ba.is_active = TRUE
       WHERE j.company_id = ?
         AND j.status = 'posted'
         AND j.journal_date BETWEEN ? AND ?
         AND (
           ba.id IS NOT NULL OR a.id IN (
             SELECT CAST(setting_value AS UNSIGNED)
             FROM settings
             WHERE company_id = ? AND setting_key IN ('default_cash_account_id', 'default_bank_account_id')
           )
         )
       GROUP BY activity`,
      [companyId, range.dateFrom, range.dateTo, companyId],
    )
    const [balanceRows] = await db.execute<RowDataPacket[]>(
      `SELECT
         COALESCE(SUM(CASE WHEN j.journal_date < ? THEN jl.debit - jl.credit ELSE 0 END), 0)
           AS opening_balance,
         COALESCE(SUM(CASE WHEN j.journal_date <= ? THEN jl.debit - jl.credit ELSE 0 END), 0)
           AS ending_balance
       FROM journals j
       INNER JOIN journal_lines jl ON jl.journal_id = j.id
       INNER JOIN accounts a ON a.id = jl.account_id AND a.company_id = j.company_id
       LEFT JOIN bank_accounts ba
         ON ba.gl_account_id = a.id AND ba.company_id = j.company_id AND ba.is_active = TRUE
       WHERE j.company_id = ?
         AND j.status = 'posted'
         AND (
           ba.id IS NOT NULL OR a.id IN (
             SELECT CAST(setting_value AS UNSIGNED)
             FROM settings
             WHERE company_id = ? AND setting_key IN ('default_cash_account_id', 'default_bank_account_id')
           )
         )`,
      [range.dateFrom, range.dateTo, companyId, companyId],
    )
    return { activities: rows, balances: balanceRows[0] ?? {} }
  }

  async aging(companyId: number, side: 'receivable' | 'payable', asOfDate: string) {
    const sales = side === 'receivable'
    const headerTable = sales ? 'sales_invoices' : 'purchase_invoices'
    const partyTable = sales ? 'customers' : 'suppliers'
    const partyForeignKey = sales ? 'customer_id' : 'supplier_id'
    const allocationTable = sales ? 'customer_payment_allocations' : 'supplier_payment_allocations'
    const paymentTable = sales ? 'customer_payments' : 'supplier_payments'
    const allocationPaymentKey = sales ? 'customer_payment_id' : 'supplier_payment_id'
    const allocationInvoiceKey = sales ? 'sales_invoice_id' : 'purchase_invoice_id'
    const returnTable = sales ? 'sales_returns' : 'purchase_returns'
    const returnInvoiceKey = sales ? 'sales_invoice_id' : 'purchase_invoice_id'

    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT
         i.id,
         i.invoice_number,
         i.invoice_date,
         i.due_date,
         p.id AS party_id,
         p.code AS party_code,
         p.name AS party_name,
         i.currency,
         i.base_grand_total AS original_amount,
         COALESCE(payments.paid_amount, 0) AS paid_amount,
         COALESCE(returns.returned_amount, 0) AS returned_amount,
         GREATEST(
           i.base_grand_total - COALESCE(payments.paid_amount, 0)
             - COALESCE(returns.returned_amount, 0),
           0
         ) AS outstanding_amount,
         GREATEST(DATEDIFF(?, i.due_date), 0) AS days_overdue,
         CASE
           WHEN ? <= i.due_date THEN 'current'
           WHEN DATEDIFF(?, i.due_date) <= 30 THEN '1-30'
           WHEN DATEDIFF(?, i.due_date) <= 60 THEN '31-60'
           WHEN DATEDIFF(?, i.due_date) <= 90 THEN '61-90'
           ELSE '>90'
         END AS aging_bucket
       FROM ${headerTable} i
       INNER JOIN ${partyTable} p ON p.id = i.${partyForeignKey} AND p.company_id = i.company_id
       LEFT JOIN (
         SELECT a.${allocationInvoiceKey} AS invoice_id, SUM(a.base_amount) AS paid_amount
         FROM ${allocationTable} a
         INNER JOIN ${paymentTable} py ON py.id = a.${allocationPaymentKey}
         WHERE py.company_id = ? AND py.status = 'posted' AND py.payment_date <= ?
         GROUP BY a.${allocationInvoiceKey}
       ) payments ON payments.invoice_id = i.id
       LEFT JOIN (
         SELECT r.${returnInvoiceKey} AS invoice_id, SUM(r.base_grand_total) AS returned_amount
         FROM ${returnTable} r
         WHERE r.company_id = ? AND r.status = 'posted' AND r.return_date <= ?
         GROUP BY r.${returnInvoiceKey}
       ) returns ON returns.invoice_id = i.id
       WHERE i.company_id = ?
         AND i.status IN ('posted', 'partially_paid', 'paid')
         AND i.invoice_date <= ?
         AND i.base_grand_total - COALESCE(payments.paid_amount, 0)
             - COALESCE(returns.returned_amount, 0) > 0
       ORDER BY i.due_date, i.invoice_number`,
      [
        asOfDate,
        asOfDate,
        asOfDate,
        asOfDate,
        asOfDate,
        companyId,
        asOfDate,
        companyId,
        asOfDate,
        companyId,
        asOfDate,
      ],
    )
    return rows
  }

  async inventoryValuation(companyId: number, asOfDate?: string) {
    if (!asOfDate) {
      const [rows] = await db.execute<RowDataPacket[]>(
        `SELECT
           ib.item_id,
           i.sku,
           i.name AS item_name,
           ib.warehouse_id,
           w.code AS warehouse_code,
           w.name AS warehouse_name,
           ib.quantity,
           ib.average_cost,
           ib.total_value,
           i.minimum_stock,
           CASE
             WHEN ib.quantity <= 0 THEN 'out_of_stock'
             WHEN ib.quantity <= i.minimum_stock THEN 'low_stock'
             ELSE 'available'
           END AS stock_status
         FROM inventory_balances ib
         INNER JOIN items i ON i.id = ib.item_id AND i.company_id = ib.company_id
         INNER JOIN warehouses w ON w.id = ib.warehouse_id AND w.company_id = ib.company_id
         WHERE ib.company_id = ?
         ORDER BY i.sku, w.code`,
        [companyId],
      )
      return rows
    }
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT
         im.item_id,
         i.sku,
         i.name AS item_name,
         im.warehouse_id,
         w.code AS warehouse_code,
         w.name AS warehouse_name,
         SUM(im.quantity_in - im.quantity_out) AS quantity,
         CASE
           WHEN SUM(im.quantity_in - im.quantity_out) = 0 THEN 0
           ELSE SUM(CASE WHEN im.quantity_in > 0 THEN im.total_cost ELSE -im.total_cost END)
             / SUM(im.quantity_in - im.quantity_out)
         END AS average_cost,
         SUM(CASE WHEN im.quantity_in > 0 THEN im.total_cost ELSE -im.total_cost END) AS total_value,
         i.minimum_stock
       FROM inventory_movements im
       INNER JOIN items i ON i.id = im.item_id AND i.company_id = im.company_id
       INNER JOIN warehouses w ON w.id = im.warehouse_id AND w.company_id = im.company_id
       WHERE im.company_id = ? AND im.movement_date <= ?
       GROUP BY im.item_id, i.sku, i.name, im.warehouse_id, w.code, w.name, i.minimum_stock
       ORDER BY i.sku, w.code`,
      [companyId, asOfDate],
    )
    return rows
  }

  async subledgerReconciliation(companyId: number, asOfDate: string) {
    const [rows] = await db.execute<RowDataPacket[]>(
      `WITH mappings AS (
         SELECT setting_key, CAST(setting_value AS UNSIGNED) AS account_id
         FROM settings
         WHERE company_id = ? AND setting_key IN (
           'default_ar_account_id', 'default_ap_account_id', 'default_inventory_account_id'
         )
       ), gl AS (
         SELECT jl.account_id, COALESCE(SUM(jl.debit - jl.credit), 0) AS debit_balance
         FROM journal_lines jl
         INNER JOIN journals j ON j.id = jl.journal_id
         WHERE j.company_id = ? AND j.status = 'posted' AND j.journal_date <= ?
         GROUP BY jl.account_id
       )
       SELECT 'ar' AS reconciliation_type,
         COALESCE((
           SELECT SUM(base_grand_total - paid_amount)
           FROM sales_invoices
           WHERE company_id = ? AND invoice_date <= ?
             AND status IN ('posted', 'partially_paid', 'paid')
         ), 0) AS subledger,
         COALESCE((SELECT debit_balance FROM gl WHERE account_id = (
           SELECT account_id FROM mappings WHERE setting_key = 'default_ar_account_id'
         )), 0) AS general_ledger
       UNION ALL
       SELECT 'ap',
         COALESCE((
           SELECT SUM(base_grand_total - paid_amount)
           FROM purchase_invoices
           WHERE company_id = ? AND invoice_date <= ?
             AND status IN ('posted', 'partially_paid', 'paid')
         ), 0),
         -COALESCE((SELECT debit_balance FROM gl WHERE account_id = (
           SELECT account_id FROM mappings WHERE setting_key = 'default_ap_account_id'
         )), 0)
       UNION ALL
       SELECT 'inventory',
         COALESCE((SELECT SUM(total_value) FROM inventory_balances WHERE company_id = ?), 0),
         COALESCE((SELECT debit_balance FROM gl WHERE account_id = (
           SELECT account_id FROM mappings WHERE setting_key = 'default_inventory_account_id'
         )), 0)
       UNION ALL
       SELECT 'bank',
         COALESCE((SELECT SUM(current_balance) FROM bank_accounts WHERE company_id = ?), 0),
         COALESCE((
           SELECT SUM(gl.debit_balance)
           FROM gl INNER JOIN bank_accounts ba ON ba.gl_account_id = gl.account_id
           WHERE ba.company_id = ? AND ba.is_active = TRUE
         ), 0)`,
      [
        companyId,
        companyId,
        asOfDate,
        companyId,
        asOfDate,
        companyId,
        asOfDate,
        companyId,
        companyId,
        companyId,
      ],
    )
    return rows
  }

  async budgetVsActual(
    companyId: number,
    filters: DateRange & { accountId?: number; costCenterId?: number; projectId?: number },
  ) {
    const conditions = ['b.company_id = ?', 'bl.month BETWEEN MONTH(?) AND MONTH(?)']
    const values: Array<string | number> = [companyId, filters.dateFrom, filters.dateTo]
    if (filters.accountId) {
      conditions.push('bl.account_id = ?')
      values.push(filters.accountId)
    }
    if (filters.costCenterId) {
      conditions.push('bl.cost_center_id = ?')
      values.push(filters.costCenterId)
    }
    if (filters.projectId) {
      conditions.push('bl.project_id = ?')
      values.push(filters.projectId)
    }
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT
         bl.account_id,
         a.code AS account_code,
         a.name AS account_name,
         a.account_type,
         bl.month,
         bl.cost_center_id,
         bl.project_id,
         SUM(bl.amount) AS budget,
         COALESCE(actual.amount, 0) AS actual
       FROM budget_lines bl
       INNER JOIN budgets b ON b.id = bl.budget_id
       INNER JOIN accounts a ON a.id = bl.account_id AND a.company_id = b.company_id
       LEFT JOIN (
         SELECT
           jl.account_id,
           MONTH(j.journal_date) AS month,
           jl.cost_center_id,
           jl.project_id,
           SUM(jl.debit - jl.credit) AS amount
         FROM journal_lines jl
         INNER JOIN journals j ON j.id = jl.journal_id
         WHERE j.company_id = ? AND j.status = 'posted' AND j.journal_date BETWEEN ? AND ?
         GROUP BY jl.account_id, MONTH(j.journal_date), jl.cost_center_id, jl.project_id
       ) actual
         ON actual.account_id = bl.account_id
        AND actual.month = bl.month
        AND actual.cost_center_id <=> bl.cost_center_id
        AND actual.project_id <=> bl.project_id
       WHERE ${conditions.join(' AND ')}
       GROUP BY bl.account_id, a.code, a.name, a.account_type, bl.month, bl.cost_center_id,
         bl.project_id, actual.amount
       ORDER BY a.code, bl.month`,
      [companyId, filters.dateFrom, filters.dateTo, ...values],
    )
    return rows
  }
}
