import {
  addColumnIfMissing,
  addIndexIfMissing,
  dropColumnIfExists,
  dropIndexIfExists,
  dropTables,
  type MigrationDatabase,
} from './helpers'

const importPermissions = [
  ['customer', 'Import pelanggan', 'import.customer'],
  ['supplier', 'Import pemasok', 'import.supplier'],
  ['item', 'Import barang dan jasa', 'import.item'],
  ['chart_of_accounts', 'Import chart of accounts', 'import.chart_of_accounts'],
  ['opening_balance', 'Import saldo awal', 'import.opening_balance'],
  ['sales', 'Import transaksi penjualan', 'import.sales'],
  ['purchase', 'Import transaksi pembelian', 'import.purchase'],
  ['journal', 'Import jurnal umum', 'import.journal'],
  ['inventory', 'Import saldo awal persediaan', 'import.inventory'],
  ['bank_statement', 'Import mutasi bank', 'import.bank_statement'],
] as const

async function extendImportJobs(db: MigrationDatabase) {
  await db.query(`ALTER TABLE import_jobs MODIFY COLUMN status
    ENUM(
      'uploaded','validating','validation_failed','ready','importing','processing',
      'completed','completed_with_errors','failed','cancelled'
    ) NOT NULL DEFAULT 'uploaded'`)

  for (const [column, definition] of [
    ['warning_rows', 'INT UNSIGNED NOT NULL DEFAULT 0'],
    ['failed_rows', 'INT UNSIGNED NOT NULL DEFAULT 0'],
    ['import_as', "ENUM('draft','submitted') NULL"],
    ['error_policy', "ENUM('all_or_nothing','valid_only') NULL"],
    ['skip_duplicates', 'BOOLEAN NOT NULL DEFAULT TRUE'],
    ['expires_at', 'DATETIME NULL'],
    ['payload_deleted_at', 'DATETIME NULL'],
  ] as const) {
    await addColumnIfMissing(db, 'import_jobs', column, definition)
  }

  await addIndexIfMissing(
    db,
    'import_jobs',
    'idx_import_job_expiry',
    'INDEX idx_import_job_expiry(status, expires_at)',
  )
}

async function createPreviewRows(db: MigrationDatabase) {
  await addColumnIfMissing(
    db,
    'import_job_errors',
    'severity',
    "ENUM('warning','error') NOT NULL DEFAULT 'error'",
  )
  await addColumnIfMissing(db, 'import_job_errors', 'field_value', 'VARCHAR(1000) NULL')

  await db.query(`CREATE TABLE IF NOT EXISTS import_job_rows(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    import_job_id BIGINT UNSIGNED NOT NULL,
    source_row_number INT UNSIGNED NOT NULL,
    row_status ENUM('valid','warning','error') NOT NULL,
    document_key VARCHAR(255) NULL,
    reference VARCHAR(191) NULL,
    description VARCHAR(500) NULL,
    is_duplicate BOOLEAN NOT NULL DEFAULT FALSE,
    normalized_data JSON NOT NULL,
    issues JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_import_job_source_row(import_job_id, source_row_number),
    CONSTRAINT fk_import_row_job FOREIGN KEY(import_job_id)
      REFERENCES import_jobs(id) ON DELETE CASCADE,
    INDEX idx_import_row_status(import_job_id, row_status, source_row_number),
    INDEX idx_import_row_document(import_job_id, document_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
}

async function seedPermissions(db: MigrationDatabase) {
  for (const [action, name, slug] of importPermissions) {
    await db.query(`INSERT IGNORE INTO permissions(module, action, name, slug)
      VALUES ('import', '${action}', '${name}', '${slug}')`)
  }
  await db.query(`INSERT IGNORE INTO role_permissions(role_id, permission_id)
    SELECT r.id, p.id
    FROM roles r
    CROSS JOIN permissions p
    WHERE r.slug = 'super-admin' AND p.module = 'import'`)
}

async function down(db: MigrationDatabase) {
  await dropTables(db, ['import_job_rows'])
  await dropColumnIfExists(db, 'import_job_errors', 'field_value')
  await dropColumnIfExists(db, 'import_job_errors', 'severity')
  await dropIndexIfExists(db, 'import_jobs', 'idx_import_job_expiry')

  await db.query(`UPDATE import_jobs SET status = 'importing' WHERE status = 'processing'`)
  await db.query(`UPDATE import_jobs SET status = 'completed' WHERE status = 'completed_with_errors'`)
  for (const column of [
    'payload_deleted_at',
    'expires_at',
    'skip_duplicates',
    'error_policy',
    'import_as',
    'failed_rows',
    'warning_rows',
  ]) {
    await dropColumnIfExists(db, 'import_jobs', column)
  }
  await db.query(`ALTER TABLE import_jobs MODIFY COLUMN status
    ENUM('uploaded','validating','validation_failed','ready','importing','completed','failed','cancelled')
    NOT NULL DEFAULT 'uploaded'`)

  await db.query(`DELETE rp FROM role_permissions rp
    INNER JOIN permissions p ON p.id = rp.permission_id
    WHERE p.module = 'import'`)
  await db.query(`DELETE FROM permissions WHERE module = 'import'`)
}

export const migration = {
  name: '008_data_import_workflow',
  up: async (db: MigrationDatabase) => {
    await extendImportJobs(db)
    await createPreviewRows(db)
    await seedPermissions(db)
  },
  down,
}
