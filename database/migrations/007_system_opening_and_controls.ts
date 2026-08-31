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

async function addPostingPeriodControls(db: MigrationDatabase) {
  await addColumnIfMissing(db, 'journals', 'accounting_period_id', 'BIGINT UNSIGNED NULL')
  await addColumnIfMissing(db, 'journals', 'posting_key', 'VARCHAR(191) NULL')
  await addForeignKeyIfMissing(
    db,
    'journals',
    'fk_journal_accounting_period',
    'FOREIGN KEY (accounting_period_id) REFERENCES accounting_periods(id)',
  )
  await addIndexIfMissing(
    db,
    'journals',
    'uq_journal_posting_key',
    'UNIQUE INDEX uq_journal_posting_key(company_id, posting_key)',
  )
  await addIndexIfMissing(
    db,
    'journals',
    'idx_journal_period',
    'INDEX idx_journal_period(company_id, accounting_period_id, status)',
  )

  for (const table of [
    'sales_invoices',
    'purchase_invoices',
    'sales_returns',
    'purchase_returns',
    'customer_payments',
    'supplier_payments',
    'stock_adjustments',
  ] as const) {
    await addColumnIfMissing(db, table, 'accounting_period_id', 'BIGINT UNSIGNED NULL')
    await addForeignKeyIfMissing(
      db,
      table,
      `fk_${table}_accounting_period`,
      'FOREIGN KEY (accounting_period_id) REFERENCES accounting_periods(id)',
    )
    await addIndexIfMissing(
      db,
      table,
      `idx_${table}_accounting_period`,
      `INDEX idx_${table}_accounting_period(company_id, accounting_period_id, status)`,
    )
  }

  await addIndexIfMissing(
    db,
    'inventory_movements',
    'idx_inventory_transaction_number',
    'INDEX idx_inventory_transaction_number(company_id, transaction_number)',
  )
}

async function extendAuditLog(db: MigrationDatabase) {
  await addColumnIfMissing(db, 'audit_logs', 'record_number', 'VARCHAR(100) NULL')
  await addColumnIfMissing(db, 'audit_logs', 'request_method', 'VARCHAR(10) NULL')
  await addColumnIfMissing(db, 'audit_logs', 'request_path', 'VARCHAR(500) NULL')
  await addColumnIfMissing(db, 'audit_logs', 'user_agent', 'VARCHAR(500) NULL')
  await addColumnIfMissing(db, 'audit_logs', 'metadata', 'JSON NULL')
  await addIndexIfMissing(
    db,
    'audit_logs',
    'idx_audit_record',
    'INDEX idx_audit_record(company_id, record_type, record_id, created_at)',
  )
  await addIndexIfMissing(
    db,
    'audit_logs',
    'idx_audit_request',
    'INDEX idx_audit_request(request_id)',
  )
}

async function createErrorAndAttachmentTables(db: MigrationDatabase) {
  await db.query(`CREATE TABLE IF NOT EXISTS error_logs(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    company_id BIGINT UNSIGNED NULL,
    user_id BIGINT UNSIGNED NULL,
    request_id VARCHAR(50) NULL,
    level ENUM('error','warn','info') NOT NULL DEFAULT 'error',
    category VARCHAR(100) NOT NULL DEFAULT 'application',
    message TEXT NOT NULL,
    error_code VARCHAR(100) NULL,
    stack_trace TEXT NULL,
    context JSON NULL,
    path VARCHAR(500) NULL,
    method VARCHAR(10) NULL,
    ip VARCHAR(45) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME NULL,
    resolved_by BIGINT UNSIGNED NULL,
    resolution_notes TEXT NULL,
    CONSTRAINT fk_error_log_company FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE SET NULL,
    CONSTRAINT fk_error_log_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_error_log_resolved_by FOREIGN KEY(resolved_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_error_log_list(company_id, level, created_at),
    INDEX idx_error_log_request(request_id),
    INDEX idx_error_log_resolution(company_id, resolved_at, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

  await db.query(`CREATE TABLE IF NOT EXISTS attachments(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    company_id BIGINT UNSIGNED NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id BIGINT UNSIGNED NOT NULL,
    category VARCHAR(50) NOT NULL DEFAULT 'supporting_document',
    file_name VARCHAR(255) NOT NULL,
    original_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    file_extension VARCHAR(20) NULL,
    file_size BIGINT UNSIGNED NOT NULL,
    storage_disk VARCHAR(50) NOT NULL DEFAULT 'local',
    storage_path VARCHAR(500) NOT NULL,
    checksum VARCHAR(128) NOT NULL,
    uploaded_by BIGINT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_by BIGINT UNSIGNED NULL,
    deleted_at DATETIME NULL,
    UNIQUE KEY uq_attachment_storage(company_id, storage_path),
    CONSTRAINT fk_attachment_company FOREIGN KEY(company_id) REFERENCES companies(id),
    CONSTRAINT fk_attachment_uploaded_by FOREIGN KEY(uploaded_by) REFERENCES users(id),
    CONSTRAINT fk_attachment_deleted_by FOREIGN KEY(deleted_by) REFERENCES users(id) ON DELETE SET NULL,
    CHECK(file_size > 0),
    INDEX idx_attachment_entity(company_id, entity_type, entity_id, deleted_at),
    INDEX idx_attachment_checksum(company_id, checksum)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
}

async function createBackupTables(db: MigrationDatabase) {
  await db.query(`CREATE TABLE IF NOT EXISTS backup_jobs(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    company_id BIGINT UNSIGNED NOT NULL,
    backup_number VARCHAR(50) NOT NULL,
    type ENUM('full','schema','data') NOT NULL DEFAULT 'full',
    status ENUM('pending','running','completed','failed','expired') NOT NULL DEFAULT 'pending',
    storage_disk VARCHAR(50) NULL,
    storage_path VARCHAR(500) NULL,
    file_name VARCHAR(255) NULL,
    file_size BIGINT UNSIGNED NULL,
    checksum VARCHAR(128) NULL,
    requested_by BIGINT UNSIGNED NOT NULL,
    started_at DATETIME NULL,
    completed_at DATETIME NULL,
    expires_at DATETIME NULL,
    error_message TEXT NULL,
    metadata JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_backup_job(company_id, backup_number),
    CONSTRAINT fk_backup_job_company FOREIGN KEY(company_id) REFERENCES companies(id),
    CONSTRAINT fk_backup_job_requested_by FOREIGN KEY(requested_by) REFERENCES users(id),
    INDEX idx_backup_job_list(company_id, status, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

  await db.query(`CREATE TABLE IF NOT EXISTS restore_jobs(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    company_id BIGINT UNSIGNED NOT NULL,
    restore_number VARCHAR(50) NOT NULL,
    backup_job_id BIGINT UNSIGNED NULL,
    uploaded_file_name VARCHAR(255) NULL,
    storage_disk VARCHAR(50) NOT NULL DEFAULT 'local',
    storage_path VARCHAR(500) NOT NULL,
    checksum VARCHAR(128) NOT NULL,
    status ENUM('pending_validation','validated','running','completed','failed','cancelled') NOT NULL DEFAULT 'pending_validation',
    validation_result JSON NULL,
    requested_by BIGINT UNSIGNED NOT NULL,
    approved_by BIGINT UNSIGNED NULL,
    approved_at DATETIME NULL,
    started_at DATETIME NULL,
    completed_at DATETIME NULL,
    error_message TEXT NULL,
    metadata JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_restore_job(company_id, restore_number),
    CONSTRAINT fk_restore_job_company FOREIGN KEY(company_id) REFERENCES companies(id),
    CONSTRAINT fk_restore_job_backup FOREIGN KEY(backup_job_id) REFERENCES backup_jobs(id) ON DELETE SET NULL,
    CONSTRAINT fk_restore_job_requested_by FOREIGN KEY(requested_by) REFERENCES users(id),
    CONSTRAINT fk_restore_job_approved_by FOREIGN KEY(approved_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_restore_job_list(company_id, status, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
}

async function createOpeningBalanceTables(db: MigrationDatabase) {
  await db.query(`CREATE TABLE IF NOT EXISTS opening_balance_batches(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    company_id BIGINT UNSIGNED NOT NULL,
    batch_number VARCHAR(50) NOT NULL,
    as_of_date DATE NOT NULL,
    balance_type ENUM('general_ledger','receivable','payable','inventory','bank','fixed_asset','mixed') NOT NULL,
    description TEXT,
    total_debit DECIMAL(20,2) NOT NULL DEFAULT 0,
    total_credit DECIMAL(20,2) NOT NULL DEFAULT 0,
    status ENUM('draft','validated','posted','reversed','cancelled') NOT NULL DEFAULT 'draft',
    journal_id BIGINT UNSIGNED NULL,
    reversal_journal_id BIGINT UNSIGNED NULL,
    created_by BIGINT UNSIGNED NOT NULL,
    updated_by BIGINT UNSIGNED NULL,
    validated_by BIGINT UNSIGNED NULL,
    validated_at DATETIME NULL,
    posted_by BIGINT UNSIGNED NULL,
    posted_at DATETIME NULL,
    reversed_by BIGINT UNSIGNED NULL,
    reversed_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    version INT UNSIGNED NOT NULL DEFAULT 1,
    UNIQUE KEY uq_opening_balance_batch(company_id, batch_number),
    CONSTRAINT fk_opening_batch_company FOREIGN KEY(company_id) REFERENCES companies(id),
    CONSTRAINT fk_opening_batch_journal FOREIGN KEY(journal_id) REFERENCES journals(id) ON DELETE SET NULL,
    CONSTRAINT fk_opening_batch_reversal_journal FOREIGN KEY(reversal_journal_id) REFERENCES journals(id) ON DELETE SET NULL,
    CONSTRAINT fk_opening_batch_created_by FOREIGN KEY(created_by) REFERENCES users(id),
    CONSTRAINT fk_opening_batch_updated_by FOREIGN KEY(updated_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_opening_batch_validated_by FOREIGN KEY(validated_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_opening_batch_posted_by FOREIGN KEY(posted_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_opening_batch_reversed_by FOREIGN KEY(reversed_by) REFERENCES users(id) ON DELETE SET NULL,
    CHECK(total_debit >= 0 AND total_credit >= 0),
    INDEX idx_opening_balance_list(company_id, as_of_date, status, balance_type)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

  await db.query(`CREATE TABLE IF NOT EXISTS opening_balance_lines(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    opening_balance_batch_id BIGINT UNSIGNED NOT NULL,
    line_number INT UNSIGNED NOT NULL,
    line_type ENUM('general_ledger','receivable','payable','inventory','bank','fixed_asset') NOT NULL,
    account_id BIGINT UNSIGNED NULL,
    customer_id BIGINT UNSIGNED NULL,
    supplier_id BIGINT UNSIGNED NULL,
    item_id BIGINT UNSIGNED NULL,
    warehouse_id BIGINT UNSIGNED NULL,
    bank_account_id BIGINT UNSIGNED NULL,
    fixed_asset_id BIGINT UNSIGNED NULL,
    document_number VARCHAR(100) NULL,
    document_date DATE NULL,
    due_date DATE NULL,
    currency CHAR(3) NOT NULL DEFAULT 'IDR',
    exchange_rate DECIMAL(20,8) NOT NULL DEFAULT 1,
    debit DECIMAL(20,2) NOT NULL DEFAULT 0,
    credit DECIMAL(20,2) NOT NULL DEFAULT 0,
    quantity DECIMAL(20,4) NULL,
    unit_cost DECIMAL(20,6) NULL,
    amount DECIMAL(20,2) NOT NULL DEFAULT 0,
    notes VARCHAR(500) NULL,
    UNIQUE KEY uq_opening_balance_line(opening_balance_batch_id, line_number),
    CONSTRAINT fk_opening_line_batch FOREIGN KEY(opening_balance_batch_id) REFERENCES opening_balance_batches(id) ON DELETE CASCADE,
    CONSTRAINT fk_opening_line_account FOREIGN KEY(account_id) REFERENCES accounts(id),
    CONSTRAINT fk_opening_line_customer FOREIGN KEY(customer_id) REFERENCES customers(id),
    CONSTRAINT fk_opening_line_supplier FOREIGN KEY(supplier_id) REFERENCES suppliers(id),
    CONSTRAINT fk_opening_line_item FOREIGN KEY(item_id) REFERENCES items(id),
    CONSTRAINT fk_opening_line_warehouse FOREIGN KEY(warehouse_id) REFERENCES warehouses(id),
    CONSTRAINT fk_opening_line_bank FOREIGN KEY(bank_account_id) REFERENCES bank_accounts(id),
    CONSTRAINT fk_opening_line_asset FOREIGN KEY(fixed_asset_id) REFERENCES fixed_assets(id),
    CHECK(exchange_rate > 0),
    CHECK(debit >= 0 AND credit >= 0),
    CHECK(NOT(debit > 0 AND credit > 0)),
    CHECK(quantity IS NULL OR quantity >= 0),
    CHECK(unit_cost IS NULL OR unit_cost >= 0),
    INDEX idx_opening_line_party(customer_id, supplier_id),
    INDEX idx_opening_line_inventory(item_id, warehouse_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
}

async function createDocumentAndImportTables(db: MigrationDatabase) {
  await db.query(`CREATE TABLE IF NOT EXISTS document_templates(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    company_id BIGINT UNSIGNED NOT NULL,
    document_type VARCHAR(50) NOT NULL,
    name VARCHAR(191) NOT NULL,
    template_format ENUM('html') NOT NULL DEFAULT 'html',
    template_content LONGTEXT NOT NULL,
    page_size ENUM('A4','A5','Letter') NOT NULL DEFAULT 'A4',
    orientation ENUM('portrait','landscape') NOT NULL DEFAULT 'portrait',
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by BIGINT UNSIGNED NOT NULL,
    updated_by BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_document_template(company_id, document_type, name),
    CONSTRAINT fk_document_template_company FOREIGN KEY(company_id) REFERENCES companies(id),
    CONSTRAINT fk_document_template_created_by FOREIGN KEY(created_by) REFERENCES users(id),
    CONSTRAINT fk_document_template_updated_by FOREIGN KEY(updated_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_document_template_default(company_id, document_type, is_default, is_active)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

  await db.query(`CREATE TABLE IF NOT EXISTS import_jobs(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    company_id BIGINT UNSIGNED NOT NULL,
    import_number VARCHAR(50) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    storage_path VARCHAR(500) NOT NULL,
    checksum VARCHAR(128) NOT NULL,
    status ENUM('uploaded','validating','validation_failed','ready','importing','completed','failed','cancelled') NOT NULL DEFAULT 'uploaded',
    total_rows INT UNSIGNED NOT NULL DEFAULT 0,
    valid_rows INT UNSIGNED NOT NULL DEFAULT 0,
    invalid_rows INT UNSIGNED NOT NULL DEFAULT 0,
    imported_rows INT UNSIGNED NOT NULL DEFAULT 0,
    validation_summary JSON NULL,
    requested_by BIGINT UNSIGNED NOT NULL,
    started_at DATETIME NULL,
    completed_at DATETIME NULL,
    error_message TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_import_job(company_id, import_number),
    CONSTRAINT fk_import_job_company FOREIGN KEY(company_id) REFERENCES companies(id),
    CONSTRAINT fk_import_job_requested_by FOREIGN KEY(requested_by) REFERENCES users(id),
    INDEX idx_import_job_list(company_id, entity_type, status, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

  await db.query(`
  CREATE TABLE IF NOT EXISTS import_job_errors (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    import_job_id BIGINT UNSIGNED NOT NULL,
    source_row_number INT UNSIGNED NOT NULL,
    field_name VARCHAR(100) NULL,
    error_code VARCHAR(100) NULL,
    error_message VARCHAR(1000) NOT NULL,
    row_data JSON NULL,

    CONSTRAINT fk_import_error_job
      FOREIGN KEY (import_job_id)
      REFERENCES import_jobs(id)
      ON DELETE CASCADE,

    INDEX idx_import_error_row (
      import_job_id,
      source_row_number
    )
  ) ENGINE=InnoDB
    DEFAULT CHARSET=utf8mb4
    COLLATE=utf8mb4_unicode_ci
`);

  await db.query(`CREATE TABLE IF NOT EXISTS export_jobs(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    company_id BIGINT UNSIGNED NOT NULL,
    export_number VARCHAR(50) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    format ENUM('csv','xlsx','pdf') NOT NULL,
    filters JSON NULL,
    status ENUM('pending','running','completed','failed','expired') NOT NULL DEFAULT 'pending',
    storage_path VARCHAR(500) NULL,
    file_name VARCHAR(255) NULL,
    file_size BIGINT UNSIGNED NULL,
    checksum VARCHAR(128) NULL,
    requested_by BIGINT UNSIGNED NOT NULL,
    started_at DATETIME NULL,
    completed_at DATETIME NULL,
    expires_at DATETIME NULL,
    error_message TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_export_job(company_id, export_number),
    CONSTRAINT fk_export_job_company FOREIGN KEY(company_id) REFERENCES companies(id),
    CONSTRAINT fk_export_job_requested_by FOREIGN KEY(requested_by) REFERENCES users(id),
    INDEX idx_export_job_list(company_id, entity_type, status, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
}

async function down(db: MigrationDatabase) {
  await dropTables(db, [
    'export_jobs',
    'import_job_errors',
    'import_jobs',
    'document_templates',
    'opening_balance_lines',
    'opening_balance_batches',
    'restore_jobs',
    'backup_jobs',
    'attachments',
    'error_logs',
  ])

  await dropIndexIfExists(db, 'audit_logs', 'idx_audit_request')
  await dropIndexIfExists(db, 'audit_logs', 'idx_audit_record')
  for (const column of [
    'metadata',
    'user_agent',
    'request_path',
    'request_method',
    'record_number',
  ]) {
    await dropColumnIfExists(db, 'audit_logs', column)
  }

  await dropIndexIfExists(db, 'inventory_movements', 'idx_inventory_transaction_number')
  for (const table of [
    'stock_adjustments',
    'supplier_payments',
    'customer_payments',
    'purchase_returns',
    'sales_returns',
    'purchase_invoices',
    'sales_invoices',
  ] as const) {
    await dropIndexIfExists(db, table, `idx_${table}_accounting_period`)
    await dropForeignKeyIfExists(db, table, `fk_${table}_accounting_period`)
    await dropColumnIfExists(db, table, 'accounting_period_id')
  }
  await dropIndexIfExists(db, 'journals', 'idx_journal_period')
  await dropIndexIfExists(db, 'journals', 'uq_journal_posting_key')
  await dropForeignKeyIfExists(db, 'journals', 'fk_journal_accounting_period')
  await dropColumnIfExists(db, 'journals', 'posting_key')
  await dropColumnIfExists(db, 'journals', 'accounting_period_id')
}

export const migration = {
  name: '007_system_opening_and_controls',
  up: async (db: MigrationDatabase) => {
    await addPostingPeriodControls(db)
    await extendAuditLog(db)
    await createErrorAndAttachmentTables(db)
    await createBackupTables(db)
    await createOpeningBalanceTables(db)
    await createDocumentAndImportTables(db)
  },
  down,
}
