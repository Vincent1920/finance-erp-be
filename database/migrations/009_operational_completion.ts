import { addColumnIfMissing, dropColumnIfExists, type MigrationDatabase } from './helpers'
export const migration = {
  name: '009_operational_completion',
  async up(db: MigrationDatabase) {
    await db.query(`CREATE TABLE IF NOT EXISTS operation_requests (
      company_id BIGINT UNSIGNED NOT NULL, request_key CHAR(36) NOT NULL,
      operation VARCHAR(50) NOT NULL, payload_hash CHAR(64) NOT NULL, result JSON NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(company_id, request_key),
      FOREIGN KEY(company_id) REFERENCES companies(id)
    ) ENGINE=InnoDB`)
    await addColumnIfMissing(db, 'purchase_invoices', 'withholding_tax_id', 'BIGINT UNSIGNED NULL')
    await addColumnIfMissing(
      db,
      'purchase_invoices',
      'withholding_amount',
      'DECIMAL(20,2) NOT NULL DEFAULT 0',
    )
    await addColumnIfMissing(
      db,
      'purchase_invoices',
      'base_withholding_amount',
      'DECIMAL(20,2) NOT NULL DEFAULT 0',
    )
    await addColumnIfMissing(
      db,
      'purchase_invoices',
      'withholding_account_id',
      'BIGINT UNSIGNED NULL',
    )
    await addColumnIfMissing(
      db,
      'purchase_returns',
      'return_stock',
      'BOOLEAN NOT NULL DEFAULT TRUE',
    )
    await addColumnIfMissing(db, 'sales_returns', 'return_stock', 'BOOLEAN NOT NULL DEFAULT TRUE')
    await db.query(
      `UPDATE number_sequences SET prefix=REPLACE(prefix, '{YYYY}', '{YYYY}-{MM}') WHERE prefix LIKE '%{YYYY}%' AND prefix NOT LIKE '%{MM}%'`,
    )
  },
  async down(db: MigrationDatabase) {
    for (const column of [
      'withholding_tax_id',
      'withholding_amount',
      'base_withholding_amount',
      'withholding_account_id',
    ])
      await dropColumnIfExists(db, 'purchase_invoices', column)
    await dropColumnIfExists(db, 'purchase_returns', 'return_stock')
    await dropColumnIfExists(db, 'sales_returns', 'return_stock')
    await db.query('DROP TABLE IF EXISTS operation_requests')
  },
}
