import type { MigrationDatabase } from './helpers'

type DefaultSetting = {
  key: string
  value: string | number | boolean
  type: 'string' | 'number' | 'boolean'
  category: string
}

export const defaults: DefaultSetting[] = [
  { key: 'accounting.allow_self_approval', value: false, type: 'boolean', category: 'accounting' },
  { key: 'accounting.materiality_threshold', value: 1000, type: 'number', category: 'accounting' },
  { key: 'accounting.rounding_decimals', value: 2, type: 'number', category: 'accounting' },
  { key: 'accounting.transaction_lock_date', value: '', type: 'string', category: 'accounting' },
  { key: 'accounting.auto_reverse_accruals', value: true, type: 'boolean', category: 'accounting' },
  { key: 'accounting.asset_capitalization_threshold', value: 5000000, type: 'number', category: 'accounting' },
  { key: 'accounting.default_asset_life_months', value: 48, type: 'number', category: 'accounting' },
  { key: 'accounting.default_depreciation_method', value: 'straight_line', type: 'string', category: 'accounting' },

  { key: 'approval.sales_invoice_threshold', value: 0, type: 'number', category: 'approval' },
  { key: 'approval.purchase_invoice_threshold', value: 0, type: 'number', category: 'approval' },
  { key: 'approval.journal_threshold', value: 0, type: 'number', category: 'approval' },
  { key: 'approval.stock_adjustment_threshold', value: 0, type: 'number', category: 'approval' },
  { key: 'approval.required_levels', value: 1, type: 'number', category: 'approval' },
  { key: 'approval.require_different_approver', value: true, type: 'boolean', category: 'approval' },

  { key: 'sales.default_payment_terms_days', value: 30, type: 'number', category: 'sales' },
  { key: 'sales.default_credit_limit', value: 0, type: 'number', category: 'sales' },
  { key: 'sales.block_over_credit_limit', value: false, type: 'boolean', category: 'sales' },
  { key: 'sales.payment_tolerance', value: 0, type: 'number', category: 'sales' },
  { key: 'sales.max_discount_percent_without_approval', value: 10, type: 'number', category: 'sales' },
  { key: 'sales.require_reference', value: false, type: 'boolean', category: 'sales' },

  { key: 'purchases.default_payment_terms_days', value: 30, type: 'number', category: 'purchases' },
  { key: 'purchases.require_purchase_order', value: false, type: 'boolean', category: 'purchases' },
  { key: 'purchases.quantity_tolerance_percent', value: 0, type: 'number', category: 'purchases' },
  { key: 'purchases.price_tolerance_percent', value: 0, type: 'number', category: 'purchases' },
  { key: 'purchases.invoice_total_tolerance', value: 0, type: 'number', category: 'purchases' },
  { key: 'purchases.freight_allocation_method', value: 'inventory_cost', type: 'string', category: 'purchases' },

  { key: 'inventory.cost_method', value: 'weighted_average', type: 'string', category: 'inventory' },
  { key: 'allow_negative_stock', value: false, type: 'boolean', category: 'inventory' },
  { key: 'inventory.quantity_decimals', value: 1, type: 'number', category: 'inventory' },
  { key: 'inventory.reorder_notifications', value: true, type: 'boolean', category: 'inventory' },
  { key: 'inventory.require_adjustment_approval', value: true, type: 'boolean', category: 'inventory' },

  { key: 'banking.reconciliation_amount_tolerance', value: 0, type: 'number', category: 'banking' },
  { key: 'banking.reconciliation_date_tolerance_days', value: 3, type: 'number', category: 'banking' },
  { key: 'banking.auto_match_enabled', value: true, type: 'boolean', category: 'banking' },
  { key: 'banking.require_reference_match', value: false, type: 'boolean', category: 'banking' },
  { key: 'banking.default_import_format', value: 'auto', type: 'string', category: 'banking' },

  { key: 'tax.is_pkp', value: false, type: 'boolean', category: 'tax' },
  { key: 'tax.default_vat_rate', value: 0, type: 'number', category: 'tax' },
  { key: 'tax.reconciliation_tolerance', value: 0, type: 'number', category: 'tax' },
  { key: 'tax.require_tax_document', value: true, type: 'boolean', category: 'tax' },
  { key: 'tax.reporting_due_day', value: 20, type: 'number', category: 'tax' },
  { key: 'tax.lock_reported_period', value: true, type: 'boolean', category: 'tax' },

  { key: 'payroll.cutoff_day', value: 25, type: 'number', category: 'payroll' },
  { key: 'payroll.payment_day', value: 28, type: 'number', category: 'payroll' },
  { key: 'payroll.overtime_multiplier', value: 1.5, type: 'number', category: 'payroll' },
  { key: 'payroll.thr_basis', value: 'basic_plus_fixed', type: 'string', category: 'payroll' },
  { key: 'payroll.prorate_method', value: 'calendar_days', type: 'string', category: 'payroll' },
  { key: 'payroll.rounding_unit', value: 1, type: 'number', category: 'payroll' },
  { key: 'payroll.lock_posted_run', value: true, type: 'boolean', category: 'payroll' },

  { key: 'notifications.receivable_due_days', value: 7, type: 'number', category: 'notifications' },
  { key: 'notifications.payable_due_days', value: 7, type: 'number', category: 'notifications' },
  { key: 'notifications.low_stock', value: true, type: 'boolean', category: 'notifications' },
  { key: 'notifications.month_end_days', value: 3, type: 'number', category: 'notifications' },
  { key: 'notifications.email_enabled', value: false, type: 'boolean', category: 'notifications' },

  { key: 'security.session_timeout_minutes', value: 480, type: 'number', category: 'security' },
  { key: 'security.password_expiry_days', value: 0, type: 'number', category: 'security' },
  { key: 'security.max_login_attempts', value: 5, type: 'number', category: 'security' },
  { key: 'security.audit_retention_days', value: 2555, type: 'number', category: 'security' },
  { key: 'security.require_reversal_reason', value: true, type: 'boolean', category: 'security' },

  { key: 'regional.date_format', value: 'DD/MM/YYYY', type: 'string', category: 'regional' },
  { key: 'regional.timezone', value: 'Asia/Jakarta', type: 'string', category: 'regional' },
  { key: 'regional.locale', value: 'id-ID', type: 'string', category: 'regional' },
  { key: 'regional.number_decimals', value: 2, type: 'number', category: 'regional' },

  { key: 'integrations.bank_duplicate_check', value: true, type: 'boolean', category: 'integrations' },
  { key: 'integrations.import_duplicate_check', value: true, type: 'boolean', category: 'integrations' },
  { key: 'integrations.webhook_enabled', value: false, type: 'boolean', category: 'integrations' },
  { key: 'integrations.coretax_enabled', value: false, type: 'boolean', category: 'integrations' },
  { key: 'integrations.api_enabled', value: false, type: 'boolean', category: 'integrations' },
]

const accountDefaults = [
  ['accounts_receivable_account_id', 'accounting', ['1130']],
  ['accounts_payable_account_id', 'accounting', ['2101', '2100']],
  ['default_cash_account_id', 'accounting', ['1101', '1110']],
  ['default_bank_account_id', 'banking', ['1102', '1120']],
  ['bank_fee_expense_account_id', 'banking', ['8101', '6500']],
  ['inventory_account_id', 'inventory', ['1140']],
  ['cost_of_goods_sold_account_id', 'inventory', ['5101', '5100']],
  ['sales_revenue_account_id', 'sales', ['4101', '4100']],
  ['salary_expense_account_id', 'payroll', ['6101', '6100']],
] as const

const literal = (value: unknown) => `'${String(value).replaceAll("'", "''")}'`

export const migration = {
  name: '026_company_policy_settings',
  async up(db: MigrationDatabase) {
    for (const setting of defaults) {
      await db.query(`INSERT INTO settings(company_id,setting_key,setting_value,value_type,category,is_secret)
        SELECT id,${literal(setting.key)},${literal(setting.value)},${literal(setting.type)},${literal(setting.category)},FALSE FROM companies
        ON DUPLICATE KEY UPDATE category=VALUES(category),value_type=VALUES(value_type)`)
    }
    for (const [key, category, codes] of accountDefaults) {
      const orderedCodes = codes.map(literal).join(',')
      await db.query(`INSERT INTO settings(company_id,setting_key,setting_value,value_type,category,is_secret)
        SELECT c.id,( ${literal(key)} ),CAST((SELECT a.id FROM accounts a WHERE a.company_id=c.id AND a.code IN (${orderedCodes}) AND a.is_posting=TRUE ORDER BY FIELD(a.code,${orderedCodes}) LIMIT 1) AS CHAR),'account_id',${literal(category)},FALSE
        FROM companies c ON DUPLICATE KEY UPDATE category=VALUES(category),value_type=VALUES(value_type)`)
    }
  },
  async down(db: MigrationDatabase) {
    const keys = [...defaults.map((item) => item.key), ...accountDefaults.map(([key]) => key)]
    await db.query(`DELETE FROM settings WHERE setting_key IN (${keys.map(literal).join(',')})`)
  },
}
