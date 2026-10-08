import type { MigrationDatabase } from './helpers'

export const migration = {
  name: '030_payroll_history_bank_profiles',
  async up(db: MigrationDatabase) {
    await db.query(`CREATE TABLE IF NOT EXISTS payroll_compensation_history(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      company_id BIGINT UNSIGNED NOT NULL,
      employee_id BIGINT UNSIGNED NOT NULL,
      effective_from DATE NOT NULL,
      basic_salary DECIMAL(19,2) NOT NULL DEFAULT 0,
      fixed_allowance DECIMAL(19,2) NOT NULL DEFAULT 0,
      reason VARCHAR(500) NOT NULL,
      created_by BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_payroll_compensation_effective(employee_id,effective_from),
      CONSTRAINT fk_payroll_compensation_company FOREIGN KEY(company_id) REFERENCES companies(id),
      CONSTRAINT fk_payroll_compensation_employee FOREIGN KEY(employee_id) REFERENCES payroll_employees(id) ON DELETE CASCADE,
      CONSTRAINT fk_payroll_compensation_creator FOREIGN KEY(created_by) REFERENCES users(id),
      INDEX idx_payroll_compensation_lookup(company_id,employee_id,effective_from)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

    await db.query(`INSERT IGNORE INTO payroll_compensation_history
      (company_id,employee_id,effective_from,basic_salary,fixed_allowance,reason,created_by)
      SELECT company_id,id,hire_date,basic_salary,fixed_allowance,'Saldo awal dari data pegawai',created_by
        FROM payroll_employees`)

    await db.query(`CREATE TABLE IF NOT EXISTS bank_matching_rules(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      company_id BIGINT UNSIGNED NOT NULL,
      name VARCHAR(191) NOT NULL,
      bank_account_id BIGINT UNSIGNED NULL,
      priority INT NOT NULL DEFAULT 100,
      direction ENUM('any','inflow','outflow') NOT NULL DEFAULT 'any',
      description_pattern VARCHAR(255) NULL,
      reference_pattern VARCHAR(255) NULL,
      amount_min DECIMAL(19,2) NULL,
      amount_max DECIMAL(19,2) NULL,
      date_tolerance_days INT UNSIGNED NOT NULL DEFAULT 3,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_bank_matching_rule(company_id,name),
      CONSTRAINT fk_bank_matching_rule_company FOREIGN KEY(company_id) REFERENCES companies(id),
      CONSTRAINT fk_bank_matching_rule_account FOREIGN KEY(bank_account_id) REFERENCES bank_accounts(id) ON DELETE CASCADE,
      CONSTRAINT fk_bank_matching_rule_creator FOREIGN KEY(created_by) REFERENCES users(id),
      INDEX idx_bank_matching_rule_lookup(company_id,bank_account_id,is_active,priority)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

    await db.query(`CREATE TABLE IF NOT EXISTS bank_import_mappings(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      company_id BIGINT UNSIGNED NOT NULL,
      name VARCHAR(191) NOT NULL,
      bank_account_id BIGINT UNSIGNED NULL,
      delimiter VARCHAR(5) NOT NULL DEFAULT ',',
      date_format VARCHAR(30) NOT NULL DEFAULT 'DD/MM/YYYY',
      decimal_separator ENUM('dot','comma') NOT NULL DEFAULT 'dot',
      header_row INT UNSIGNED NOT NULL DEFAULT 1,
      column_mapping JSON NOT NULL,
      is_default TINYINT(1) NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_bank_import_mapping(company_id,name),
      CONSTRAINT fk_bank_import_mapping_company FOREIGN KEY(company_id) REFERENCES companies(id),
      CONSTRAINT fk_bank_import_mapping_account FOREIGN KEY(bank_account_id) REFERENCES bank_accounts(id) ON DELETE SET NULL,
      CONSTRAINT fk_bank_import_mapping_creator FOREIGN KEY(created_by) REFERENCES users(id),
      INDEX idx_bank_import_mapping_lookup(company_id,bank_account_id,is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  },
  async down(db: MigrationDatabase) {
    await db.query('DROP TABLE IF EXISTS bank_import_mappings')
    await db.query('DROP TABLE IF EXISTS bank_matching_rules')
    await db.query('DROP TABLE IF EXISTS payroll_compensation_history')
  },
}
