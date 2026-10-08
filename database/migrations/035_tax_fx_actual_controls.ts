import { addColumnIfMissing, type MigrationDatabase } from './helpers'
export const migration = {
  name: '035_tax_fx_actual_controls',
  async up(db: MigrationDatabase) {
    await db.query(`CREATE TABLE IF NOT EXISTS currency_bank_operations (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, company_id BIGINT UNSIGNED NOT NULL,
      operation_type VARCHAR(20) NOT NULL, operation_date DATE NOT NULL,
      from_bank_id BIGINT UNSIGNED NOT NULL,to_bank_id BIGINT UNSIGNED NULL,
      from_amount DECIMAL(20,2) NOT NULL DEFAULT 0,to_amount DECIMAL(20,2) NOT NULL DEFAULT 0,
      from_base DECIMAL(20,2) NOT NULL,to_base DECIMAL(20,2) NOT NULL,
      exchange_rate DECIMAL(20,8) NOT NULL,fee_amount DECIMAL(20,2) NOT NULL DEFAULT 0,
      reference VARCHAR(100),journal_id BIGINT UNSIGNED NULL,created_by BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX(company_id,operation_date),FOREIGN KEY(company_id) REFERENCES companies(id),
      FOREIGN KEY(from_bank_id) REFERENCES bank_accounts(id),FOREIGN KEY(to_bank_id) REFERENCES bank_accounts(id),
      FOREIGN KEY(journal_id) REFERENCES journals(id),FOREIGN KEY(created_by) REFERENCES users(id)
    ) ENGINE=InnoDB`)
    await db.query(`CREATE TABLE IF NOT EXISTS tax_report_versions (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,company_id BIGINT UNSIGNED NOT NULL,
      period_id BIGINT UNSIGNED NOT NULL,revision INT NOT NULL,source_file VARCHAR(255),
      snapshot JSON NOT NULL,reason VARCHAR(1000) NOT NULL,created_by BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX(company_id,period_id),FOREIGN KEY(period_id) REFERENCES tax_reconciliation_periods(id)
    ) ENGINE=InnoDB`)
    await db.query(`CREATE TABLE IF NOT EXISTS tax_payment_evidence (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,company_id BIGINT UNSIGNED NOT NULL,
      tax_period CHAR(7) NOT NULL,tax_group VARCHAR(20) NOT NULL,payment_date DATE NOT NULL,
      ntpn VARCHAR(40) NOT NULL,journal_id BIGINT UNSIGNED NOT NULL,account_id BIGINT UNSIGNED NOT NULL,
      amount DECIMAL(20,2) NOT NULL,notes VARCHAR(500),created_by BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id,ntpn,tax_group,account_id),INDEX(company_id,tax_period),
      FOREIGN KEY(journal_id) REFERENCES journals(id),FOREIGN KEY(account_id) REFERENCES accounts(id)
    ) ENGINE=InnoDB`)
    await addColumnIfMissing(
      db,
      'accounting_schedule_entries',
      'actual_line_id',
      'BIGINT UNSIGNED NULL',
    )
    await addColumnIfMissing(
      db,
      'accounting_schedule_entries',
      'actual_verified',
      'BOOLEAN NOT NULL DEFAULT FALSE',
    )
    // Legacy comparisons are observations until supported by a validated source.
    await db.query(
      "UPDATE accounting_schedule_entries SET status='generated' WHERE status='reconciled' AND actual_verified=FALSE",
    )
    for (const table of ['customer_payments', 'supplier_payments']) {
      await addColumnIfMissing(db, table, 'fx_amount', 'DECIMAL(20,2) NOT NULL DEFAULT 0')
      await addColumnIfMissing(db, table, 'carrying_base_amount', 'DECIMAL(20,2) NULL')
    }
  },
  async down() {
    throw new Error('Migration contains accounting history; restore a verified backup instead')
  },
}
