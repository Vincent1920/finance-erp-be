import type { MigrationDatabase } from './helpers'
import { addColumnIfMissing, dropColumnIfExists } from './helpers'

export const migration = {
  name: '023_schedule_controls',
  async up(db: MigrationDatabase) {
    await addColumnIfMissing(
      db,
      'accounting_schedules',
      'materiality_threshold',
      'DECIMAL(20,2) NOT NULL DEFAULT 0 AFTER total_estimated_amount',
    )
    await db.query(`CREATE TABLE IF NOT EXISTS accounting_schedule_templates(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      company_id BIGINT UNSIGNED NOT NULL,
      name VARCHAR(191) NOT NULL,
      schedule_type ENUM('accrual','prepayment') NOT NULL,
      description TEXT NULL,
      periods_count INT UNSIGNED NOT NULL,
      default_amount DECIMAL(20,2) NULL,
      materiality_threshold DECIMAL(20,2) NOT NULL DEFAULT 0,
      pnl_account_id BIGINT UNSIGNED NOT NULL,
      balance_sheet_account_id BIGINT UNSIGNED NOT NULL,
      auto_reverse BOOLEAN NOT NULL DEFAULT FALSE,
      auto_submit BOOLEAN NOT NULL DEFAULT TRUE,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_accounting_schedule_template(company_id,name),
      INDEX idx_accounting_schedule_template_active(company_id,is_active),
      CONSTRAINT fk_accounting_schedule_template_company FOREIGN KEY(company_id) REFERENCES companies(id),
      CONSTRAINT fk_accounting_schedule_template_pnl FOREIGN KEY(pnl_account_id) REFERENCES accounts(id),
      CONSTRAINT fk_accounting_schedule_template_balance FOREIGN KEY(balance_sheet_account_id) REFERENCES accounts(id),
      CONSTRAINT fk_accounting_schedule_template_creator FOREIGN KEY(created_by) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  },
  async down(db: MigrationDatabase) {
    await db.query('DROP TABLE IF EXISTS accounting_schedule_templates')
    await dropColumnIfExists(db, 'accounting_schedules', 'materiality_threshold')
  },
}
