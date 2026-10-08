import type { RowDataPacket } from 'mysql2/promise'

import { db } from '../config/database'
import { pagination } from '../utils/pagination'
import { ValidationError } from '../utils/AppError'
import type { QueryExecutor } from '../types/database'

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
  constructor(private connection: QueryExecutor = db) {}
  async companyReportingSettings(companyId: number) {
    const [rows] = await this.connection.execute<RowDataPacket[]>(
      `SELECT fiscal_year_start, base_currency
       FROM companies
       WHERE id = ?
       LIMIT 1`,
      [companyId],
    )
    return rows[0] ?? { fiscal_year_start: 1, base_currency: 'IDR' }
  }

  async generalLedger(companyId: number, filters: LedgerFilters, connection: QueryExecutor = this.connection) {
    const { page, limit, offset } = pagination(filters.page, filters.limit)
    const conditions = [
      'j.company_id = ?',
      "j.status IN ('posted','reversed')",
      'j.journal_date BETWEEN ? AND ?',
    ]
    const values: Array<string | number> = [companyId, filters.dateFrom, filters.dateTo]
    const openingConditions = [
      'j.company_id = ?',
      "j.status IN ('posted','reversed')",
      'j.journal_date < ?',
    ]
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
    const searchCondition = filters.reference
      ? 'WHERE (reference LIKE ? OR journal_number LIKE ? OR description LIKE ? OR account_code LIKE ? OR account_name LIKE ?)'
      : ''
    const searchValues = filters.reference ? Array(5).fill('%' + filters.reference + '%') : []

    const [rows] = await connection.query<RowDataPacket[]>(
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
           company.base_currency AS report_currency,
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
         INNER JOIN companies company ON company.id = j.company_id
         LEFT JOIN opening o ON o.account_id = jl.account_id
         LEFT JOIN cost_centers cc ON cc.id = jl.cost_center_id AND cc.company_id = j.company_id
         LEFT JOIN projects p ON p.id = jl.project_id AND p.company_id = j.company_id
         WHERE ${conditions.join(' AND ')}
       ), balances AS (SELECT
         entries.*,
         opening_balance + SUM(debit - credit) OVER (
           PARTITION BY account_id ORDER BY journal_date, journal_id, id
         ) AS running_balance
       FROM entries)
       SELECT balances.*, CAST(debit AS CHAR) AS debit, CAST(credit AS CHAR) AS credit,
         CAST(running_balance AS CHAR) AS running_balance, COUNT(*) OVER () AS total_rows FROM balances
       ${searchCondition}
       ORDER BY journal_number, journal_id, id
       LIMIT ? OFFSET ?`,
      [...openingValues, ...values, ...searchValues, limit, offset],
    )

    return { rows, page, limit, total: Number(rows[0]?.total_rows ?? 0) }
  }

  async trialBalance(companyId: number, range: DateRange): Promise<TrialBalanceRow[]> {
    const [rows] = await this.connection.execute<TrialBalanceRow[]>(
      `WITH balances AS (
         SELECT
           a.id,
           a.code,
           a.name,
           a.account_type,
           a.normal_balance,
           a.presentation_order,
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
          AND j.status IN ('posted','reversed')
          AND j.journal_date <= ?
         WHERE a.company_id = ?
           AND a.deleted_at IS NULL
           AND a.is_posting = TRUE
         GROUP BY a.id, a.code, a.name, a.account_type, a.normal_balance, a.presentation_order
       )
       SELECT
         balances.*,
         GREATEST((opening_debit + period_debit) - (opening_credit + period_credit), 0)
           AS ending_debit,
         GREATEST((opening_credit + period_credit) - (opening_debit + period_debit), 0)
           AS ending_credit
       FROM balances
       ORDER BY FIELD(account_type,'asset','liability','equity','revenue','cogs','expense','other_income','other_expense'),COALESCE(presentation_order,990000),code`,
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

  async accountMovements(companyId: number, range: DateRange, excludeYearEnd = false) {
    const [rows] = await this.connection.execute<RowDataPacket[]>(
      `SELECT
         a.id,
         a.code,
         a.name,
         a.account_type,
         a.normal_balance,
         a.report_group,
         COALESCE(SUM(CASE WHEN j.id IS NOT NULL THEN jl.debit ELSE 0 END), 0) AS debit,
         COALESCE(SUM(CASE WHEN j.id IS NOT NULL THEN jl.credit ELSE 0 END), 0) AS credit
       FROM accounts a
       LEFT JOIN journal_lines jl ON jl.account_id = a.id
       LEFT JOIN journals j
         ON j.id = jl.journal_id
        AND j.company_id = a.company_id
        AND j.status IN ('posted','reversed')
        AND j.journal_date BETWEEN ? AND ?
        AND (? = FALSE OR COALESCE(j.source_type, '') NOT IN ('year_end_closing','year_end_retained_earnings','year_end_closing_reversal','year_end_retained_reversal'))
       WHERE a.company_id = ?
         AND a.deleted_at IS NULL
         AND a.is_posting = TRUE
       GROUP BY a.id, a.code, a.name, a.account_type, a.normal_balance, a.report_group
       ORDER BY FIELD(a.account_type,'asset','liability','equity','revenue','cogs','expense','other_income','other_expense'),COALESCE(a.presentation_order,990000),a.code`,
      [range.dateFrom, range.dateTo, excludeYearEnd, companyId],
    )
    return rows
  }

  async accountBalancesAsOf(companyId: number, asOfDate: string) {
    const [rows] = await this.connection.execute<RowDataPacket[]>(
      `SELECT
         a.id,
         a.code,
         a.name,
         a.account_type,
         a.normal_balance,
         COALESCE(SUM(CASE WHEN j.id IS NOT NULL THEN jl.debit ELSE 0 END), 0) AS debit,
         COALESCE(SUM(CASE WHEN j.id IS NOT NULL THEN jl.credit ELSE 0 END), 0) AS credit
       FROM accounts a
       LEFT JOIN journal_lines jl ON jl.account_id = a.id
       LEFT JOIN journals j
         ON j.id = jl.journal_id
        AND j.company_id = a.company_id
        AND j.status IN ('posted','reversed')
        AND j.journal_date <= ?
       WHERE a.company_id = ?
         AND a.deleted_at IS NULL
         AND a.is_posting = TRUE
       GROUP BY a.id, a.code, a.name, a.account_type, a.normal_balance
       ORDER BY FIELD(a.account_type,'asset','liability','equity','revenue','cogs','expense','other_income','other_expense'),COALESCE(a.presentation_order,990000),a.code`,
      [asOfDate, companyId],
    )
    return rows
  }

  async cashFlow(companyId: number, range: DateRange) {
    const [rows] = await this.connection.execute<RowDataPacket[]>(
      `WITH cash_accounts AS (
         SELECT DISTINCT a.id
         FROM accounts a
         INNER JOIN bank_accounts ba
           ON ba.gl_account_id = a.id
          AND ba.company_id = a.company_id
          AND ba.is_active = TRUE
         WHERE a.company_id = ? AND a.deleted_at IS NULL
         UNION
         SELECT DISTINCT a.id
         FROM settings s
         INNER JOIN accounts a
           ON a.id = CAST(s.setting_value AS UNSIGNED)
          AND a.company_id = s.company_id
          AND a.deleted_at IS NULL
         WHERE s.company_id = ?
           AND s.setting_key IN ('default_cash_account_id', 'default_bank_account_id')
       ), journal_activity AS (
         SELECT
           j.id,
           COALESCE(
             CASE
               WHEN COUNT(DISTINCT CASE
                 WHEN ca.id IS NULL
                  AND oa.cash_flow_category IN ('operating', 'investing', 'financing')
                 THEN oa.cash_flow_category
               END) = 1
               THEN MAX(CASE
                 WHEN ca.id IS NULL
                  AND oa.cash_flow_category IN ('operating', 'investing', 'financing')
                 THEN oa.cash_flow_category
               END)
             END,
             CASE
               WHEN j.source_type IN ('fixed_asset_acquisition', 'fixed_asset_disposal')
                 THEN 'investing'
               WHEN j.source_type IN (
                 'capital_contribution', 'dividend', 'loan_receipt', 'loan_payment',
                 'year_end_closing'
               ) THEN 'financing'
               ELSE 'operating'
             END
           ) AS activity
         FROM journals j
         INNER JOIN journal_lines ol ON ol.journal_id = j.id
         INNER JOIN accounts oa ON oa.id = ol.account_id AND oa.company_id = j.company_id
         LEFT JOIN cash_accounts ca ON ca.id = oa.id
         WHERE j.company_id = ?
           AND j.status IN ('posted','reversed')
           AND j.journal_date BETWEEN ? AND ?
         GROUP BY j.id, j.source_type
       )
       SELECT
         ja.activity,
         COALESCE(SUM(jl.debit - jl.credit), 0) AS amount
       FROM journal_activity ja
       INNER JOIN journal_lines jl ON jl.journal_id = ja.id
       INNER JOIN cash_accounts ca ON ca.id = jl.account_id
       GROUP BY ja.activity`,
      [companyId, companyId, companyId, range.dateFrom, range.dateTo],
    )
    const [balanceRows] = await this.connection.execute<RowDataPacket[]>(
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
         AND j.status IN ('posted','reversed')
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

    const [rows] = await this.connection.execute<RowDataPacket[]>(
      `SELECT
         i.id,
         i.invoice_number,
         i.invoice_date,
         i.due_date,
         p.id AS party_id,
         p.code AS party_code,
         p.name AS party_name,
         company.base_currency AS currency,
         i.currency AS transaction_currency,
         i.exchange_rate,
         i.base_grand_total AS original_amount,
         COALESCE(payments.paid_amount, 0) AS paid_amount,
         COALESCE(returns.returned_amount, 0) AS returned_amount,
         COALESCE(credits.credit_amount, 0) AS credit_amount,
         GREATEST(
           i.base_grand_total - COALESCE(payments.paid_amount, 0)
             - COALESCE(returns.returned_amount, 0)
             - COALESCE(credits.credit_amount, 0),
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
       INNER JOIN companies company ON company.id=i.company_id
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
       LEFT JOIN (
         SELECT ca.target_invoice_id AS invoice_id, SUM(ca.base_amount) AS credit_amount
         FROM party_credit_applications ca
         INNER JOIN party_credits pc ON pc.id=ca.party_credit_id
         WHERE ca.company_id=? AND ca.status='posted' AND ca.application_type='invoice'
           AND ca.application_date<=? AND pc.party_type=?
         GROUP BY ca.target_invoice_id
       ) credits ON credits.invoice_id=i.id
       WHERE i.company_id = ?
         AND i.status IN ('posted', 'partially_paid', 'paid')
         AND i.invoice_date <= ?
         AND i.base_grand_total - COALESCE(payments.paid_amount, 0)
             - COALESCE(returns.returned_amount, 0)
             - COALESCE(credits.credit_amount, 0) > 0
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
        side === 'receivable' ? 'customer' : 'supplier',
        companyId,
        asOfDate,
      ],
    )
    return rows
  }

  async inventoryValuation(companyId: number, asOfDate?: string) {
    if (!asOfDate) {
      const [rows] = await this.connection.execute<RowDataPacket[]>(
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
    const [rows] = await this.connection.execute<RowDataPacket[]>(
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
    const [unvalued]=await this.connection.execute<RowDataPacket[]>(`SELECT b.code,
      COALESCE((SELECT s.closing_balance FROM bank_statements s WHERE s.company_id=b.company_id AND s.bank_account_id=b.id AND s.period_end<=? ORDER BY s.period_end DESC,s.id DESC LIMIT 1),0) statement_balance,
      COALESCE((SELECT SUM(l.currency_debit-l.currency_credit) FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.company_id=b.company_id AND l.account_id=b.gl_account_id AND j.status IN('posted','reversed') AND j.journal_date<=? AND l.currency_code=b.currency),0) native_balance
      FROM bank_accounts b JOIN companies c ON c.id=b.company_id WHERE b.company_id=? AND b.is_active=TRUE AND b.deleted_at IS NULL AND b.currency<>c.base_currency
      HAVING statement_balance<>0 AND native_balance=0`,[asOfDate,asOfDate,companyId])
    if(unvalued.length)throw new ValidationError(`Rekening valas ${unvalued.map(b=>b.code).join(', ')} memiliki saldo rekening koran tanpa saldo valuta di buku. Lengkapi transaksi/migrasi valuta sebelum membandingkan nilai rupiah.`)
    const [rows] = await this.connection.execute<RowDataPacket[]>(
      `WITH gl AS (
         SELECT jl.account_id, COALESCE(SUM(jl.debit - jl.credit), 0) AS debit_balance,
           SUM(CASE WHEN jl.currency_code IS NOT NULL THEN jl.currency_debit-jl.currency_credit ELSE 0 END) native_balance
         FROM journal_lines jl
         INNER JOIN journals j ON j.id = jl.journal_id
         WHERE j.company_id = ? AND j.status IN ('posted','reversed') AND j.journal_date <= ?
         GROUP BY jl.account_id
       ), control_accounts AS (
         SELECT 'ar' reconciliation_type,c.control_account_id account_id FROM (SELECT company_id,receivable_account_id control_account_id FROM customers UNION SELECT company_id,control_account_id FROM sales_invoices) c WHERE c.company_id=? AND c.control_account_id IS NOT NULL GROUP BY c.control_account_id
         UNION SELECT 'ap',s.control_account_id FROM (SELECT company_id,payable_account_id control_account_id FROM suppliers UNION SELECT company_id,control_account_id FROM purchase_invoices) s WHERE s.company_id=? AND s.control_account_id IS NOT NULL GROUP BY s.control_account_id
         UNION SELECT 'inventory',i.inventory_account_id FROM items i WHERE i.company_id=? AND i.inventory_account_id IS NOT NULL GROUP BY i.inventory_account_id
         UNION SELECT 'bank',b.gl_account_id FROM bank_accounts b WHERE b.company_id=? AND b.is_active=TRUE AND b.deleted_at IS NULL GROUP BY b.gl_account_id
       ), subledger AS (
         SELECT 'ar' reconciliation_type,si.control_account_id account_id,
           COALESCE(SUM(si.base_grand_total),0)
           -COALESCE((SELECT SUM(a.base_amount) FROM customer_payment_allocations a JOIN customer_payments p ON p.id=a.customer_payment_id JOIN sales_invoices x ON x.id=a.sales_invoice_id JOIN customers cp ON cp.id=x.customer_id WHERE p.company_id=? AND p.status='posted' AND p.payment_date<=? AND x.control_account_id=si.control_account_id),0)
           -COALESCE((SELECT SUM(r.base_grand_total) FROM sales_returns r JOIN sales_invoices rx ON rx.id=r.sales_invoice_id AND rx.company_id=r.company_id WHERE r.company_id=? AND r.status='posted' AND r.return_date<=? AND rx.control_account_id=si.control_account_id),0)
           +COALESCE((SELECT SUM(a.base_amount) FROM party_credit_applications a JOIN party_credits pc ON pc.id=a.party_credit_id WHERE a.company_id=? AND pc.party_type='customer' AND pc.control_account_id=si.control_account_id AND a.application_type='refund' AND a.status='posted' AND a.application_date<=?),0) amount
         FROM sales_invoices si WHERE si.invoice_date<=? AND si.status IN('posted','partially_paid','paid') AND si.company_id=? AND si.control_account_id IS NOT NULL GROUP BY si.control_account_id
         UNION ALL
         SELECT 'ap',pi.control_account_id,
           COALESCE(SUM(pi.base_grand_total),0)
           -COALESCE((SELECT SUM(a.base_amount) FROM supplier_payment_allocations a JOIN supplier_payments p ON p.id=a.supplier_payment_id JOIN purchase_invoices x ON x.id=a.purchase_invoice_id JOIN suppliers sp ON sp.id=x.supplier_id WHERE p.company_id=? AND p.status='posted' AND p.payment_date<=? AND x.control_account_id=pi.control_account_id),0)
           -COALESCE((SELECT SUM(r.base_grand_total) FROM purchase_returns r JOIN purchase_invoices rx ON rx.id=r.purchase_invoice_id AND rx.company_id=r.company_id WHERE r.company_id=? AND r.status='posted' AND r.return_date<=? AND rx.control_account_id=pi.control_account_id),0)
           +COALESCE((SELECT SUM(a.base_amount) FROM party_credit_applications a JOIN party_credits pc ON pc.id=a.party_credit_id WHERE a.company_id=? AND pc.party_type='supplier' AND pc.control_account_id=pi.control_account_id AND a.application_type='refund' AND a.status='posted' AND a.application_date<=?),0)
         FROM purchase_invoices pi WHERE pi.invoice_date<=? AND pi.status IN('posted','partially_paid','paid') AND pi.company_id=? AND pi.control_account_id IS NOT NULL GROUP BY pi.control_account_id
         UNION ALL
         SELECT 'inventory',i.inventory_account_id,SUM(CASE WHEN im.quantity_in>0 THEN im.total_cost ELSE -im.total_cost END) FROM inventory_movements im JOIN items i ON i.id=im.item_id AND i.company_id=im.company_id WHERE im.company_id=? AND im.movement_date<=? AND i.inventory_account_id IS NOT NULL GROUP BY i.inventory_account_id
         UNION ALL
         SELECT 'bank',b.gl_account_id,COALESCE(SUM((SELECT bs.closing_balance FROM bank_statements bs WHERE bs.company_id=b.company_id AND bs.bank_account_id=b.id AND bs.period_end<=? ORDER BY bs.period_end DESC,bs.id DESC LIMIT 1)
           * CASE WHEN b.currency=c.base_currency THEN 1 ELSE COALESCE(g.debit_balance/NULLIF(g.native_balance,0),0) END),0)
         FROM bank_accounts b JOIN companies c ON c.id=b.company_id LEFT JOIN gl g ON g.account_id=b.gl_account_id
         WHERE b.company_id=? AND b.is_active=TRUE AND b.deleted_at IS NULL GROUP BY b.gl_account_id
       )
       SELECT ca.reconciliation_type,a.id account_id,a.code account_code,a.name account_name,COALESCE(s.amount,0) subledger,
         CASE WHEN ca.reconciliation_type='ap' THEN -COALESCE(gl.debit_balance,0) ELSE COALESCE(gl.debit_balance,0) END general_ledger
       FROM control_accounts ca JOIN accounts a ON a.id=ca.account_id LEFT JOIN subledger s ON s.reconciliation_type=ca.reconciliation_type AND s.account_id=ca.account_id LEFT JOIN gl ON gl.account_id=ca.account_id
       ORDER BY FIELD(ca.reconciliation_type,'ar','ap','inventory','bank'),a.code`,
      [
        companyId,
        asOfDate,
        companyId,
        companyId,
        companyId,
        companyId,
        companyId,
        asOfDate,
        companyId,
        asOfDate,
        companyId,
        asOfDate,
        asOfDate,
        companyId,
        companyId,
        asOfDate,
        companyId,
        asOfDate,
        companyId,
        asOfDate,
        asOfDate,
        companyId,
        companyId,
        asOfDate,
        asOfDate,
        companyId,
      ],
    )
    return rows
  }

  async fixedAssetReconciliation(companyId: number, asOfDate: string) {
    const [rows] = await this.connection.execute<RowDataPacket[]>(
      `WITH gl AS (
         SELECT jl.account_id,COALESCE(SUM(jl.debit-jl.credit),0) debit_balance
           FROM journal_lines jl JOIN journals j ON j.id=jl.journal_id
          WHERE j.company_id=? AND j.status IN('posted','reversed') AND j.journal_date<=?
          GROUP BY jl.account_id
       ), asset_cost AS (
         SELECT fa.asset_account_id account_id,SUM(fa.purchase_cost) amount
           FROM fixed_assets fa
          WHERE fa.company_id=? AND fa.deleted_at IS NULL AND fa.in_service_date<=?
            AND fa.status<>'draft' AND (fa.disposal_date IS NULL OR fa.disposal_date>?)
          GROUP BY fa.asset_account_id
       ), accumulated AS (
         SELECT fa.accumulated_depreciation_account_id account_id,SUM(ad.depreciation_amount) amount
           FROM asset_depreciations ad JOIN fixed_assets fa ON fa.id=ad.fixed_asset_id
          WHERE ad.company_id=? AND ad.status='posted' AND ad.depreciation_date<=?
            AND fa.deleted_at IS NULL AND (fa.disposal_date IS NULL OR fa.disposal_date>?)
          GROUP BY fa.accumulated_depreciation_account_id
       )
       SELECT 'fixed_asset' reconciliation_type,a.id account_id,a.code account_code,a.name account_name,
              ac.amount subledger,COALESCE(gl.debit_balance,0) general_ledger
         FROM asset_cost ac JOIN accounts a ON a.id=ac.account_id LEFT JOIN gl ON gl.account_id=ac.account_id
       UNION ALL
       SELECT 'accumulated_depreciation',a.id,a.code,a.name,ad.amount,-COALESCE(gl.debit_balance,0)
         FROM accumulated ad JOIN accounts a ON a.id=ad.account_id LEFT JOIN gl ON gl.account_id=ad.account_id
       ORDER BY account_code`,
      [companyId, asOfDate, companyId, asOfDate, asOfDate, companyId, asOfDate, asOfDate],
    )
    return rows
  }

  async payrollReconciliation(companyId: number, asOfDate: string) {
    const [rows] = await this.connection.execute<RowDataPacket[]>(
      `WITH gl AS (
         SELECT jl.account_id,COALESCE(SUM(jl.debit-jl.credit),0) debit_balance
           FROM journal_lines jl JOIN journals j ON j.id=jl.journal_id
          WHERE j.company_id=? AND j.status IN('posted','reversed') AND j.journal_date<=?
          GROUP BY jl.account_id
       ), payroll_due AS (
         SELECT pp.payroll_payable_account_id account_id,SUM(pr.total_take_home_pay) amount
           FROM payroll_runs pr JOIN payroll_policies pp ON pp.id=pr.policy_id
          WHERE pr.company_id=? AND pr.status='posted' AND pr.date_to<=?
          GROUP BY pp.payroll_payable_account_id
       )
       SELECT 'payroll' reconciliation_type,a.id account_id,a.code account_code,a.name account_name,
              p.amount subledger,-COALESCE(gl.debit_balance,0) general_ledger
         FROM payroll_due p JOIN accounts a ON a.id=p.account_id LEFT JOIN gl ON gl.account_id=p.account_id
        ORDER BY a.code`,
      [companyId, asOfDate, companyId, asOfDate],
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
    const [rows] = await this.connection.execute<RowDataPacket[]>(
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
         WHERE j.company_id = ? AND j.status IN ('posted','reversed') AND j.journal_date BETWEEN ? AND ?
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
