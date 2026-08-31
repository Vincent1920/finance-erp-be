import {
  addColumnIfMissing,
  addForeignKeyIfMissing,
  addIndexIfMissing,
  dropColumnIfExists,
  dropForeignKeyIfExists,
  dropIndexIfExists,
  dropTables,
  type MigrationDatabase,
} from './helpers'

async function addUserAndConfigurationFoundation(db: MigrationDatabase) {
  await addColumnIfMissing(db, 'users', 'updated_by', 'BIGINT UNSIGNED NULL')
  await addColumnIfMissing(db, 'users', 'password_changed_at', 'DATETIME NULL')
  await addColumnIfMissing(
    db,
    'users',
    'failed_login_attempts',
    'SMALLINT UNSIGNED NOT NULL DEFAULT 0',
  )
  await addColumnIfMissing(db, 'users', 'last_failed_login_at', 'DATETIME NULL')
  await addColumnIfMissing(db, 'users', 'locked_at', 'DATETIME NULL')
  await addColumnIfMissing(db, 'users', 'locked_by', 'BIGINT UNSIGNED NULL')
  await addForeignKeyIfMissing(
    db,
    'users',
    'fk_users_updated_by',
    'FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL',
  )
  await addForeignKeyIfMissing(
    db,
    'users',
    'fk_users_locked_by',
    'FOREIGN KEY (locked_by) REFERENCES users(id) ON DELETE SET NULL',
  )

  await addColumnIfMissing(db, 'roles', 'company_id', 'BIGINT UNSIGNED NULL')
  await addColumnIfMissing(db, 'roles', 'is_system', 'BOOLEAN NOT NULL DEFAULT FALSE')
  await addColumnIfMissing(db, 'roles', 'is_active', 'BOOLEAN NOT NULL DEFAULT TRUE')
  await addForeignKeyIfMissing(
    db,
    'roles',
    'fk_roles_company',
    'FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE',
  )
  await addIndexIfMissing(
    db,
    'roles',
    'idx_roles_company_active',
    'INDEX idx_roles_company_active(company_id, is_active)',
  )

  await addColumnIfMissing(db, 'settings', 'category', "VARCHAR(50) NOT NULL DEFAULT 'general'")
  await addColumnIfMissing(
    db,
    'settings',
    'value_type',
    "ENUM('string','number','boolean','json','account_id') NOT NULL DEFAULT 'string'",
  )
  await addColumnIfMissing(db, 'settings', 'is_secret', 'BOOLEAN NOT NULL DEFAULT FALSE')
  await addIndexIfMissing(
    db,
    'settings',
    'idx_settings_category',
    'INDEX idx_settings_category(company_id, category)',
  )

  await addColumnIfMissing(db, 'number_sequences', 'last_reset_key', 'VARCHAR(20) NULL')
  await addColumnIfMissing(
    db,
    'number_sequences',
    'created_at',
    'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP',
  )

  await addColumnIfMissing(
    db,
    'accounts',
    'cash_flow_category',
    "ENUM('operating','investing','financing','non_cash') NULL",
  )
  await addColumnIfMissing(db, 'accounts', 'report_group', 'VARCHAR(100) NULL')
  await addIndexIfMissing(
    db,
    'accounts',
    'idx_accounts_report',
    'INDEX idx_accounts_report(company_id, report_group, is_active)',
  )

  await addColumnIfMissing(db, 'customers', 'currency', "CHAR(3) NOT NULL DEFAULT 'IDR'")
  await addColumnIfMissing(db, 'suppliers', 'currency', "CHAR(3) NOT NULL DEFAULT 'IDR'")

  await db.query(
    'ALTER TABLE items MODIFY COLUMN average_cost DECIMAL(20,6) NOT NULL DEFAULT 0',
  )
}

async function addPeriodLifecycle(db: MigrationDatabase) {
  await addColumnIfMissing(db, 'accounting_periods', 'soft_closed_at', 'DATETIME NULL')
  await addColumnIfMissing(db, 'accounting_periods', 'soft_closed_by', 'BIGINT UNSIGNED NULL')
  await addColumnIfMissing(db, 'accounting_periods', 'reopened_at', 'DATETIME NULL')
  await addColumnIfMissing(db, 'accounting_periods', 'reopened_by', 'BIGINT UNSIGNED NULL')
  await addColumnIfMissing(db, 'accounting_periods', 'close_notes', 'TEXT NULL')
  await addForeignKeyIfMissing(
    db,
    'accounting_periods',
    'fk_period_soft_closed_by',
    'FOREIGN KEY (soft_closed_by) REFERENCES users(id) ON DELETE SET NULL',
  )
  await addForeignKeyIfMissing(
    db,
    'accounting_periods',
    'fk_period_reopened_by',
    'FOREIGN KEY (reopened_by) REFERENCES users(id) ON DELETE SET NULL',
  )
}

async function addJournalLifecycle(db: MigrationDatabase) {
  const columns = [
    ['currency', "CHAR(3) NOT NULL DEFAULT 'IDR'"],
    ['exchange_rate', 'DECIMAL(20,8) NOT NULL DEFAULT 1'],
    ['total_debit', 'DECIMAL(20,2) NOT NULL DEFAULT 0'],
    ['total_credit', 'DECIMAL(20,2) NOT NULL DEFAULT 0'],
    ['submitted_by', 'BIGINT UNSIGNED NULL'],
    ['submitted_at', 'DATETIME NULL'],
    ['rejected_by', 'BIGINT UNSIGNED NULL'],
    ['rejected_at', 'DATETIME NULL'],
    ['rejection_reason', 'TEXT NULL'],
    ['reversed_by', 'BIGINT UNSIGNED NULL'],
    ['reversed_at', 'DATETIME NULL'],
    ['reversal_journal_id', 'BIGINT UNSIGNED NULL'],
    ['original_journal_id', 'BIGINT UNSIGNED NULL'],
    ['cancelled_by', 'BIGINT UNSIGNED NULL'],
    ['cancelled_at', 'DATETIME NULL'],
    ['cancellation_reason', 'TEXT NULL'],
    ['version', 'INT UNSIGNED NOT NULL DEFAULT 1'],
  ] as const

  for (const [column, definition] of columns) {
    await addColumnIfMissing(db, 'journals', column, definition)
  }

  await db.query(
    `ALTER TABLE journals MODIFY COLUMN status
       ENUM('draft','pending_approval','approved','rejected','posted','reversed','cancelled')
       NOT NULL DEFAULT 'draft'`,
  )

  for (const [constraint, column] of [
    ['fk_journal_submitted_by', 'submitted_by'],
    ['fk_journal_rejected_by', 'rejected_by'],
    ['fk_journal_reversed_by', 'reversed_by'],
    ['fk_journal_cancelled_by', 'cancelled_by'],
  ] as const) {
    await addForeignKeyIfMissing(
      db,
      'journals',
      constraint,
      `FOREIGN KEY (${column}) REFERENCES users(id) ON DELETE SET NULL`,
    )
  }
  await addForeignKeyIfMissing(
    db,
    'journals',
    'fk_journal_reversal',
    'FOREIGN KEY (reversal_journal_id) REFERENCES journals(id) ON DELETE SET NULL',
  )
  await addForeignKeyIfMissing(
    db,
    'journals',
    'fk_journal_original',
    'FOREIGN KEY (original_journal_id) REFERENCES journals(id) ON DELETE SET NULL',
  )
  await addIndexIfMissing(
    db,
    'journals',
    'idx_journal_source',
    'INDEX idx_journal_source(company_id, source_type, source_id)',
  )

  for (const [column, definition] of [
    ['line_number', 'INT UNSIGNED NOT NULL DEFAULT 1'],
    ['currency_debit', 'DECIMAL(20,2) NOT NULL DEFAULT 0'],
    ['currency_credit', 'DECIMAL(20,2) NOT NULL DEFAULT 0'],
    ['exchange_rate', 'DECIMAL(20,8) NOT NULL DEFAULT 1'],
  ] as const) {
    await addColumnIfMissing(db, 'journal_lines', column, definition)
  }
  await addIndexIfMissing(
    db,
    'journal_lines',
    'idx_journal_line_dimensions',
    'INDEX idx_journal_line_dimensions(cost_center_id, project_id)',
  )
}

async function addInvoiceHeaderLifecycle(
  db: MigrationDatabase,
  table: 'sales_invoices' | 'purchase_invoices',
) {
  const columns = [
    ['notes', 'TEXT NULL'],
    ['currency', "CHAR(3) NOT NULL DEFAULT 'IDR'"],
    ['exchange_rate', 'DECIMAL(20,8) NOT NULL DEFAULT 1'],
    ['base_subtotal', 'DECIMAL(20,2) NOT NULL DEFAULT 0'],
    ['base_discount', 'DECIMAL(20,2) NOT NULL DEFAULT 0'],
    ['base_tax', 'DECIMAL(20,2) NOT NULL DEFAULT 0'],
    ['base_grand_total', 'DECIMAL(20,2) NOT NULL DEFAULT 0'],
    [
      'payment_status',
      "ENUM('unpaid','partial','paid','overpaid') NOT NULL DEFAULT 'unpaid'",
    ],
    ['journal_id', 'BIGINT UNSIGNED NULL'],
    ['reversal_journal_id', 'BIGINT UNSIGNED NULL'],
    ['submitted_by', 'BIGINT UNSIGNED NULL'],
    ['submitted_at', 'DATETIME NULL'],
    ['approved_at', 'DATETIME NULL'],
    ['rejected_by', 'BIGINT UNSIGNED NULL'],
    ['rejected_at', 'DATETIME NULL'],
    ['rejection_reason', 'TEXT NULL'],
    ['reversed_by', 'BIGINT UNSIGNED NULL'],
    ['reversed_at', 'DATETIME NULL'],
    ['cancelled_by', 'BIGINT UNSIGNED NULL'],
    ['cancelled_at', 'DATETIME NULL'],
    ['cancellation_reason', 'TEXT NULL'],
    ['version', 'INT UNSIGNED NOT NULL DEFAULT 1'],
  ] as const

  for (const [column, definition] of columns) {
    await addColumnIfMissing(db, table, column, definition)
  }

  if (table === 'purchase_invoices') {
    await addColumnIfMissing(db, table, 'reference', 'VARCHAR(100) NULL')
    await addColumnIfMissing(db, table, 'approval_status', 'VARCHAR(30) NULL')
    await addColumnIfMissing(db, table, 'approved_by', 'BIGINT UNSIGNED NULL')
  }

  await db.query(
    `ALTER TABLE ${table} MODIFY COLUMN status
       ENUM('draft','pending_approval','approved','rejected','posted','partially_paid','paid','reversed','cancelled')
       NOT NULL DEFAULT 'draft'`,
  )

  const prefix = table === 'sales_invoices' ? 'sales_invoice' : 'purchase_invoice'
  for (const [suffix, column] of [
    ['submitted_by', 'submitted_by'],
    ['approved_by', 'approved_by'],
    ['rejected_by', 'rejected_by'],
    ['reversed_by', 'reversed_by'],
    ['cancelled_by', 'cancelled_by'],
  ] as const) {
    await addForeignKeyIfMissing(
      db,
      table,
      `fk_${prefix}_${suffix}`,
      `FOREIGN KEY (${column}) REFERENCES users(id) ON DELETE SET NULL`,
    )
  }
  await addForeignKeyIfMissing(
    db,
    table,
    `fk_${prefix}_journal`,
    'FOREIGN KEY (journal_id) REFERENCES journals(id) ON DELETE SET NULL',
  )
  await addForeignKeyIfMissing(
    db,
    table,
    `fk_${prefix}_reversal_journal`,
    'FOREIGN KEY (reversal_journal_id) REFERENCES journals(id) ON DELETE SET NULL',
  )
  await addIndexIfMissing(
    db,
    table,
    `idx_${prefix}_due`,
    `INDEX idx_${prefix}_due(company_id, due_date, payment_status)`,
  )
}

async function addInvoiceLineFoundation(
  db: MigrationDatabase,
  table: 'sales_invoice_lines' | 'purchase_invoice_lines',
) {
  const accountColumn = table === 'sales_invoice_lines' ? 'revenue_account_id' : 'expense_account_id'
  const columns = [
    ['line_number', 'INT UNSIGNED NOT NULL DEFAULT 1'],
    [accountColumn, 'BIGINT UNSIGNED NULL'],
    ['discount_percent', 'DECIMAL(9,6) NOT NULL DEFAULT 0'],
    ['tax_rate', 'DECIMAL(8,4) NOT NULL DEFAULT 0'],
    ['base_subtotal', 'DECIMAL(20,2) NOT NULL DEFAULT 0'],
    ['base_tax_amount', 'DECIMAL(20,2) NOT NULL DEFAULT 0'],
    ['returned_quantity', 'DECIMAL(20,4) NOT NULL DEFAULT 0'],
  ] as const

  for (const [column, definition] of columns) {
    await addColumnIfMissing(db, table, column, definition)
  }

  const prefix = table === 'sales_invoice_lines' ? 'sales_invoice_line' : 'purchase_invoice_line'
  await addForeignKeyIfMissing(
    db,
    table,
    `fk_${prefix}_account`,
    `FOREIGN KEY (${accountColumn}) REFERENCES accounts(id)`,
  )
}

async function addInvoiceAndInventoryFoundation(db: MigrationDatabase) {
  await addInvoiceHeaderLifecycle(db, 'sales_invoices')
  await addInvoiceHeaderLifecycle(db, 'purchase_invoices')
  await addInvoiceLineFoundation(db, 'sales_invoice_lines')
  await addInvoiceLineFoundation(db, 'purchase_invoice_lines')

  await db.query(
    `UPDATE sales_invoices
        SET base_subtotal = subtotal,
            base_discount = discount,
            base_tax = tax,
            base_grand_total = grand_total
      WHERE exchange_rate = 1 AND base_grand_total = 0`,
  )
  await db.query(
    `UPDATE purchase_invoices
        SET base_subtotal = subtotal,
            base_discount = discount,
            base_tax = tax,
            base_grand_total = grand_total
      WHERE exchange_rate = 1 AND base_grand_total = 0`,
  )

  await db.query(
    'ALTER TABLE inventory_balances MODIFY COLUMN average_cost DECIMAL(20,6) NOT NULL DEFAULT 0',
  )
  await addColumnIfMissing(
    db,
    'inventory_balances',
    'total_value',
    'DECIMAL(20,2) NOT NULL DEFAULT 0',
  )
  await addColumnIfMissing(
    db,
    'inventory_balances',
    'version',
    'INT UNSIGNED NOT NULL DEFAULT 1',
  )
  await db.query(
    'UPDATE inventory_balances SET total_value = ROUND(quantity * average_cost, 2)',
  )

  await db.query(
    'ALTER TABLE inventory_movements MODIFY COLUMN unit_cost DECIMAL(20,6) NOT NULL',
  )
  for (const [column, definition] of [
    ['source_line_id', 'BIGINT UNSIGNED NULL'],
    ['journal_id', 'BIGINT UNSIGNED NULL'],
    ['reversal_movement_id', 'BIGINT UNSIGNED NULL'],
    ['is_reversal', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['posting_key', 'VARCHAR(191) NULL'],
  ] as const) {
    await addColumnIfMissing(db, 'inventory_movements', column, definition)
  }
  await addForeignKeyIfMissing(
    db,
    'inventory_movements',
    'fk_inventory_movement_journal',
    'FOREIGN KEY (journal_id) REFERENCES journals(id) ON DELETE SET NULL',
  )
  await addForeignKeyIfMissing(
    db,
    'inventory_movements',
    'fk_inventory_movement_reversal',
    'FOREIGN KEY (reversal_movement_id) REFERENCES inventory_movements(id) ON DELETE SET NULL',
  )
  await addIndexIfMissing(
    db,
    'inventory_movements',
    'uq_inventory_posting_key',
    'UNIQUE INDEX uq_inventory_posting_key(company_id, posting_key)',
  )
  await addIndexIfMissing(
    db,
    'inventory_movements',
    'idx_inventory_source',
    'INDEX idx_inventory_source(company_id, transaction_type, transaction_id)',
  )
}

async function createCurrencyAndAccountMappingTables(db: MigrationDatabase) {
  await db.query(`CREATE TABLE IF NOT EXISTS currencies(
    code CHAR(3) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    symbol VARCHAR(10),
    decimal_places TINYINT UNSIGNED NOT NULL DEFAULT 2,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

  await db.query(`CREATE TABLE IF NOT EXISTS company_currencies(
    company_id BIGINT UNSIGNED NOT NULL,
    currency_code CHAR(3) NOT NULL,
    is_base BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(company_id, currency_code),
    CONSTRAINT fk_company_currency_company FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE,
    CONSTRAINT fk_company_currency_currency FOREIGN KEY(currency_code) REFERENCES currencies(code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

  await db.query(`CREATE TABLE IF NOT EXISTS exchange_rates(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    company_id BIGINT UNSIGNED NOT NULL,
    rate_date DATE NOT NULL,
    from_currency CHAR(3) NOT NULL,
    to_currency CHAR(3) NOT NULL,
    exchange_rate DECIMAL(20,8) NOT NULL,
    source VARCHAR(100),
    created_by BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_exchange_rate(company_id, rate_date, from_currency, to_currency),
    CONSTRAINT fk_exchange_rate_company FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE,
    CONSTRAINT fk_exchange_rate_from_currency FOREIGN KEY(from_currency) REFERENCES currencies(code),
    CONSTRAINT fk_exchange_rate_to_currency FOREIGN KEY(to_currency) REFERENCES currencies(code),
    CONSTRAINT fk_exchange_rate_created_by FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL,
    CHECK(exchange_rate > 0),
    INDEX idx_exchange_rate_lookup(company_id, from_currency, to_currency, rate_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

  await db.query(`CREATE TABLE IF NOT EXISTS account_mappings(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    company_id BIGINT UNSIGNED NOT NULL,
    mapping_key VARCHAR(100) NOT NULL,
    account_id BIGINT UNSIGNED NOT NULL,
    description VARCHAR(255),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_account_mapping(company_id, mapping_key),
    CONSTRAINT fk_account_mapping_company FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE,
    CONSTRAINT fk_account_mapping_account FOREIGN KEY(account_id) REFERENCES accounts(id),
    INDEX idx_account_mapping_account(company_id, account_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
}

async function createBankAccounts(db: MigrationDatabase) {
  await db.query(`CREATE TABLE IF NOT EXISTS bank_accounts(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    company_id BIGINT UNSIGNED NOT NULL,
    code VARCHAR(30) NOT NULL,
    bank_name VARCHAR(150) NOT NULL,
    account_number VARCHAR(100) NOT NULL,
    account_name VARCHAR(191) NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'IDR',
    gl_account_id BIGINT UNSIGNED NOT NULL,
    opening_balance DECIMAL(20,2) NOT NULL DEFAULT 0,
    current_balance DECIMAL(20,2) NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by BIGINT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL,
    UNIQUE KEY uq_bank_account_code(company_id, code),
    UNIQUE KEY uq_bank_account_number(company_id, account_number),
    CONSTRAINT fk_bank_account_company FOREIGN KEY(company_id) REFERENCES companies(id),
    CONSTRAINT fk_bank_account_gl FOREIGN KEY(gl_account_id) REFERENCES accounts(id),
    CONSTRAINT fk_bank_account_created_by FOREIGN KEY(created_by) REFERENCES users(id),
    CHECK(currency = UPPER(currency)),
    INDEX idx_bank_account_active(company_id, is_active)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
}

async function down(db: MigrationDatabase) {
  await dropTables(db, [
    'bank_accounts',
    'account_mappings',
    'exchange_rates',
    'company_currencies',
    'currencies',
  ])

  await dropForeignKeyIfExists(db, 'inventory_movements', 'fk_inventory_movement_reversal')
  await dropForeignKeyIfExists(db, 'inventory_movements', 'fk_inventory_movement_journal')
  await dropIndexIfExists(db, 'inventory_movements', 'uq_inventory_posting_key')
  await dropIndexIfExists(db, 'inventory_movements', 'idx_inventory_source')
  for (const column of [
    'posting_key',
    'is_reversal',
    'reversal_movement_id',
    'journal_id',
    'source_line_id',
  ]) {
    await dropColumnIfExists(db, 'inventory_movements', column)
  }
  for (const column of ['version', 'total_value']) {
    await dropColumnIfExists(db, 'inventory_balances', column)
  }

  for (const table of ['purchase_invoice_lines', 'sales_invoice_lines'] as const) {
    const prefix = table === 'sales_invoice_lines' ? 'sales_invoice_line' : 'purchase_invoice_line'
    await dropForeignKeyIfExists(db, table, `fk_${prefix}_account`)
    for (const column of [
      'returned_quantity',
      'base_tax_amount',
      'base_subtotal',
      'tax_rate',
      'discount_percent',
      table === 'sales_invoice_lines' ? 'revenue_account_id' : 'expense_account_id',
      'line_number',
    ]) {
      await dropColumnIfExists(db, table, column)
    }
  }

  for (const table of ['purchase_invoices', 'sales_invoices'] as const) {
    const prefix = table === 'sales_invoices' ? 'sales_invoice' : 'purchase_invoice'
    await dropIndexIfExists(db, table, `idx_${prefix}_due`)
    for (const suffix of [
      'reversal_journal',
      'journal',
      'cancelled_by',
      'reversed_by',
      'rejected_by',
      'approved_by',
      'submitted_by',
    ]) {
      await dropForeignKeyIfExists(db, table, `fk_${prefix}_${suffix}`)
    }
    const columns = [
      'version',
      'cancellation_reason',
      'cancelled_at',
      'cancelled_by',
      'reversed_at',
      'reversed_by',
      'rejection_reason',
      'rejected_at',
      'rejected_by',
      'approved_at',
      'submitted_at',
      'submitted_by',
      'reversal_journal_id',
      'journal_id',
      'payment_status',
      'base_grand_total',
      'base_tax',
      'base_discount',
      'base_subtotal',
      'exchange_rate',
      'currency',
      'notes',
    ]
    if (table === 'purchase_invoices') {
      columns.push('approved_by', 'approval_status', 'reference')
    }
    for (const column of columns) {
      await dropColumnIfExists(db, table, column)
    }
  }

  await dropIndexIfExists(db, 'journal_lines', 'idx_journal_line_dimensions')
  for (const column of ['exchange_rate', 'currency_credit', 'currency_debit', 'line_number']) {
    await dropColumnIfExists(db, 'journal_lines', column)
  }
  await dropIndexIfExists(db, 'journals', 'idx_journal_source')
  for (const constraint of [
    'fk_journal_original',
    'fk_journal_reversal',
    'fk_journal_cancelled_by',
    'fk_journal_reversed_by',
    'fk_journal_rejected_by',
    'fk_journal_submitted_by',
  ]) {
    await dropForeignKeyIfExists(db, 'journals', constraint)
  }
  for (const column of [
    'version',
    'cancellation_reason',
    'cancelled_at',
    'cancelled_by',
    'original_journal_id',
    'reversal_journal_id',
    'reversed_at',
    'reversed_by',
    'rejection_reason',
    'rejected_at',
    'rejected_by',
    'submitted_at',
    'submitted_by',
    'total_credit',
    'total_debit',
    'exchange_rate',
    'currency',
  ]) {
    await dropColumnIfExists(db, 'journals', column)
  }

  for (const constraint of ['fk_period_reopened_by', 'fk_period_soft_closed_by']) {
    await dropForeignKeyIfExists(db, 'accounting_periods', constraint)
  }
  for (const column of [
    'close_notes',
    'reopened_by',
    'reopened_at',
    'soft_closed_by',
    'soft_closed_at',
  ]) {
    await dropColumnIfExists(db, 'accounting_periods', column)
  }

  await dropColumnIfExists(db, 'suppliers', 'currency')
  await dropColumnIfExists(db, 'customers', 'currency')
  await dropIndexIfExists(db, 'accounts', 'idx_accounts_report')
  await dropColumnIfExists(db, 'accounts', 'report_group')
  await dropColumnIfExists(db, 'accounts', 'cash_flow_category')
  await dropColumnIfExists(db, 'number_sequences', 'created_at')
  await dropColumnIfExists(db, 'number_sequences', 'last_reset_key')
  await dropIndexIfExists(db, 'settings', 'idx_settings_category')
  await dropColumnIfExists(db, 'settings', 'is_secret')
  await dropColumnIfExists(db, 'settings', 'value_type')
  await dropColumnIfExists(db, 'settings', 'category')
  await dropIndexIfExists(db, 'roles', 'idx_roles_company_active')
  await dropForeignKeyIfExists(db, 'roles', 'fk_roles_company')
  await dropColumnIfExists(db, 'roles', 'is_active')
  await dropColumnIfExists(db, 'roles', 'is_system')
  await dropColumnIfExists(db, 'roles', 'company_id')
  await dropForeignKeyIfExists(db, 'users', 'fk_users_locked_by')
  await dropForeignKeyIfExists(db, 'users', 'fk_users_updated_by')
  for (const column of [
    'locked_by',
    'locked_at',
    'last_failed_login_at',
    'failed_login_attempts',
    'password_changed_at',
    'updated_by',
  ]) {
    await dropColumnIfExists(db, 'users', column)
  }
}

export const migration = {
  name: '004_foundation_lifecycle',
  up: async (db: MigrationDatabase) => {
    await addUserAndConfigurationFoundation(db)
    await addPeriodLifecycle(db)
    await addJournalLifecycle(db)
    await addInvoiceAndInventoryFoundation(db)
    await createCurrencyAndAccountMappingTables(db)
    await createBankAccounts(db)
  },
  down,
}
