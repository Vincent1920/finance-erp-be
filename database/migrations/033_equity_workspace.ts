import type { MigrationDatabase } from './helpers'

export const migration = {
  name: '033_equity_workspace',
  async up(db: MigrationDatabase) {
    await db.query(`CREATE TABLE IF NOT EXISTS shareholders (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      company_id BIGINT UNSIGNED NOT NULL,
      code VARCHAR(40) NOT NULL, name VARCHAR(191) NOT NULL,
      email VARCHAR(191) NULL, notes VARCHAR(1000) NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE, version INT UNSIGNED NOT NULL DEFAULT 1,
      created_by BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_shareholder_code(company_id,code),
      FOREIGN KEY(company_id) REFERENCES companies(id), FOREIGN KEY(created_by) REFERENCES users(id)
    ) ENGINE=InnoDB`)
    await db.query(`CREATE TABLE IF NOT EXISTS shareholder_holdings (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      shareholder_id BIGINT UNSIGNED NOT NULL, effective_date DATE NOT NULL,
      shares BIGINT UNSIGNED NOT NULL, nominal_value DECIMAL(18,2) NOT NULL,
      reason VARCHAR(1000) NOT NULL, created_by BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_shareholder_effective(shareholder_id,effective_date),
      FOREIGN KEY(shareholder_id) REFERENCES shareholders(id), FOREIGN KEY(created_by) REFERENCES users(id)
    ) ENGINE=InnoDB`)
    await db.query(`CREATE TABLE IF NOT EXISTS equity_transactions (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, company_id BIGINT UNSIGNED NOT NULL,
      transaction_number VARCHAR(100) NOT NULL, shareholder_id BIGINT UNSIGNED NOT NULL,
      transaction_date DATE NOT NULL,
      transaction_type ENUM('contribution','opening_detail','dividend') NOT NULL,
      amount DECIMAL(18,2) NOT NULL, currency CHAR(3) NOT NULL,
      equity_account_id BIGINT UNSIGNED NOT NULL, counterpart_account_id BIGINT UNSIGNED NULL,
      journal_id BIGINT UNSIGNED NULL, reference VARCHAR(100) NULL, notes VARCHAR(1000) NULL,
      cancelled_at DATETIME NULL, created_by BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_equity_number(company_id,transaction_number),
      INDEX idx_equity_date(company_id,transaction_date), INDEX idx_equity_journal(journal_id,equity_account_id),
      CHECK(amount>0), FOREIGN KEY(company_id) REFERENCES companies(id),
      FOREIGN KEY(shareholder_id) REFERENCES shareholders(id), FOREIGN KEY(equity_account_id) REFERENCES accounts(id),
      FOREIGN KEY(counterpart_account_id) REFERENCES accounts(id), FOREIGN KEY(journal_id) REFERENCES journals(id),
      FOREIGN KEY(created_by) REFERENCES users(id)
    ) ENGINE=InnoDB`)
  },
  async down(db: MigrationDatabase) {
    await db.query('DROP TABLE IF EXISTS equity_transactions')
    await db.query('DROP TABLE IF EXISTS shareholder_holdings')
    await db.query('DROP TABLE IF EXISTS shareholders')
  },
}
