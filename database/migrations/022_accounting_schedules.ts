import type { Pool } from 'mysql2/promise'

export const migration = {
  name: '022_accounting_schedules',
  up: async (db: Pool) => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS accounting_schedules (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        company_id BIGINT UNSIGNED NOT NULL,
        schedule_number VARCHAR(50) NOT NULL,
        schedule_type ENUM('accrual','prepayment') NOT NULL,
        name VARCHAR(191) NOT NULL,
        description TEXT NULL,
        reference VARCHAR(100) NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        periods_count INT UNSIGNED NOT NULL,
        total_estimated_amount DECIMAL(20,2) NOT NULL,
        pnl_account_id BIGINT UNSIGNED NOT NULL,
        balance_sheet_account_id BIGINT UNSIGNED NOT NULL,
        auto_reverse BOOLEAN NOT NULL DEFAULT FALSE,
        auto_submit BOOLEAN NOT NULL DEFAULT TRUE,
        status ENUM('active','completed','cancelled') NOT NULL DEFAULT 'active',
        created_by BIGINT UNSIGNED NOT NULL,
        updated_by BIGINT UNSIGNED NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at DATETIME NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        UNIQUE KEY uk_accounting_schedule_number(company_id,schedule_number),
        INDEX idx_accounting_schedule_status(company_id,status,start_date,end_date),
        CONSTRAINT fk_accounting_schedule_company FOREIGN KEY(company_id) REFERENCES companies(id),
        CONSTRAINT fk_accounting_schedule_pnl FOREIGN KEY(pnl_account_id) REFERENCES accounts(id),
        CONSTRAINT fk_accounting_schedule_balance FOREIGN KEY(balance_sheet_account_id) REFERENCES accounts(id),
        CONSTRAINT fk_accounting_schedule_creator FOREIGN KEY(created_by) REFERENCES users(id),
        CONSTRAINT fk_accounting_schedule_updater FOREIGN KEY(updated_by) REFERENCES users(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    await db.query(`
      CREATE TABLE IF NOT EXISTS accounting_schedule_entries (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        company_id BIGINT UNSIGNED NOT NULL,
        schedule_id BIGINT UNSIGNED NOT NULL,
        period_number INT UNSIGNED NOT NULL,
        scheduled_date DATE NOT NULL,
        estimated_amount DECIMAL(20,2) NOT NULL,
        actual_amount DECIMAL(20,2) NULL,
        variance_amount DECIMAL(20,2) NULL,
        actual_reference VARCHAR(100) NULL,
        actual_journal_id BIGINT UNSIGNED NULL,
        recognition_journal_id BIGINT UNSIGNED NULL,
        reversal_journal_id BIGINT UNSIGNED NULL,
        status ENUM('scheduled','generated','reconciled','cancelled') NOT NULL DEFAULT 'scheduled',
        generated_by BIGINT UNSIGNED NULL,
        generated_at DATETIME NULL,
        reconciled_by BIGINT UNSIGNED NULL,
        reconciled_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_accounting_schedule_period(schedule_id,period_number),
        INDEX idx_accounting_schedule_entry_due(company_id,scheduled_date,status),
        CONSTRAINT fk_accounting_schedule_entry_company FOREIGN KEY(company_id) REFERENCES companies(id),
        CONSTRAINT fk_accounting_schedule_entry_schedule FOREIGN KEY(schedule_id) REFERENCES accounting_schedules(id),
        CONSTRAINT fk_accounting_schedule_entry_actual_journal FOREIGN KEY(actual_journal_id) REFERENCES journals(id),
        CONSTRAINT fk_accounting_schedule_entry_recognition FOREIGN KEY(recognition_journal_id) REFERENCES journals(id),
        CONSTRAINT fk_accounting_schedule_entry_reversal FOREIGN KEY(reversal_journal_id) REFERENCES journals(id),
        CONSTRAINT fk_accounting_schedule_entry_generator FOREIGN KEY(generated_by) REFERENCES users(id),
        CONSTRAINT fk_accounting_schedule_entry_reconciler FOREIGN KEY(reconciled_by) REFERENCES users(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
  },
  down: async (db: Pool) => {
    await db.query('DROP TABLE IF EXISTS accounting_schedule_entries')
    await db.query('DROP TABLE IF EXISTS accounting_schedules')
  },
}
