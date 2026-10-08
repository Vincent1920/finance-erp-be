import type { MigrationDatabase } from './helpers'
import { addColumnIfMissing, addForeignKeyIfMissing, dropColumnIfExists, dropForeignKeyIfExists } from './helpers'

export const migration = {
  name: '031_accounting_core_controls',
  async up(db: MigrationDatabase) {
    await addColumnIfMissing(db, 'account_mappings', 'created_by', 'BIGINT UNSIGNED NULL')
    await addColumnIfMissing(db, 'account_mappings', 'updated_by', 'BIGINT UNSIGNED NULL')
    await addForeignKeyIfMissing(db, 'account_mappings', 'fk_account_mapping_creator', 'FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL')
    await addForeignKeyIfMissing(db, 'account_mappings', 'fk_account_mapping_updater', 'FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL')

    await db.query(`CREATE TABLE IF NOT EXISTS period_reopen_requests(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      company_id BIGINT UNSIGNED NOT NULL,
      accounting_period_id BIGINT UNSIGNED NOT NULL,
      previous_status ENUM('soft_closed','closed','locked') NOT NULL,
      target_status ENUM('open','soft_closed','closed') NOT NULL,
      reason TEXT NOT NULL,
      status ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
      requested_by BIGINT UNSIGNED NOT NULL,
      requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      decided_by BIGINT UNSIGNED NULL,
      decided_at DATETIME NULL,
      decision_notes TEXT NULL,
      CONSTRAINT fk_period_reopen_company FOREIGN KEY(company_id) REFERENCES companies(id),
      CONSTRAINT fk_period_reopen_period FOREIGN KEY(accounting_period_id) REFERENCES accounting_periods(id),
      CONSTRAINT fk_period_reopen_requester FOREIGN KEY(requested_by) REFERENCES users(id),
      CONSTRAINT fk_period_reopen_decider FOREIGN KEY(decided_by) REFERENCES users(id) ON DELETE SET NULL,
      INDEX idx_period_reopen_queue(company_id,status,requested_at),
      INDEX idx_period_reopen_period(accounting_period_id,status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

    await db.query("ALTER TABLE accounting_periods MODIFY status ENUM('open','soft_closed','closed','locked') NOT NULL DEFAULT 'open'")
    await addColumnIfMissing(db, 'accounting_periods', 'locked_at', 'DATETIME NULL')
    await addColumnIfMissing(db, 'accounting_periods', 'locked_by', 'BIGINT UNSIGNED NULL')
    await addForeignKeyIfMissing(db, 'accounting_periods', 'fk_period_locked_by', 'FOREIGN KEY (locked_by) REFERENCES users(id) ON DELETE SET NULL')
    await db.query("ALTER TABLE period_close_runs MODIFY requested_status ENUM('soft_closed','closed','locked') NOT NULL")
    await db.query("ALTER TABLE period_close_checks MODIFY check_code ENUM('account_mapping_complete','ar_reconciled','ap_reconciled','inventory_reconciled','bank_reconciled','depreciation_posted','recurring_journals_reviewed','trial_balance_balanced','financial_statements_consistent') NOT NULL")
  },
  async down(db: MigrationDatabase) {
    await db.query('DROP TABLE IF EXISTS period_reopen_requests')
    await dropForeignKeyIfExists(db, 'account_mappings', 'fk_account_mapping_updater')
    await dropForeignKeyIfExists(db, 'account_mappings', 'fk_account_mapping_creator')
    await dropColumnIfExists(db, 'account_mappings', 'updated_by')
    await dropColumnIfExists(db, 'account_mappings', 'created_by')
    await dropForeignKeyIfExists(db, 'accounting_periods', 'fk_period_locked_by')
    await dropColumnIfExists(db, 'accounting_periods', 'locked_by')
    await dropColumnIfExists(db, 'accounting_periods', 'locked_at')
    await db.query("ALTER TABLE period_close_checks MODIFY check_code ENUM('ar_reconciled','ap_reconciled','inventory_reconciled','bank_reconciled','depreciation_posted','recurring_journals_reviewed','trial_balance_balanced') NOT NULL")
    await db.query("ALTER TABLE period_close_runs MODIFY requested_status ENUM('soft_closed','closed') NOT NULL")
    await db.query("ALTER TABLE accounting_periods MODIFY status ENUM('open','soft_closed','closed') NOT NULL DEFAULT 'open'")
  },
}
