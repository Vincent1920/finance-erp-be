import type { MigrationDatabase } from './helpers'
import { dropTables } from './helpers'

export const migration = {
  name: '014_indonesian_tax_workspaces',
  async up(db: MigrationDatabase) {
    await db.query(`ALTER TABLE tax_report_rows MODIFY tax_type
      ENUM('ppn_output','ppn_input','pph','pph21_employee','pph21_non_employee','pph23','pph42') NOT NULL`)
    await db.query(`CREATE TABLE IF NOT EXISTS tax_internal_rows(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      company_id BIGINT UNSIGNED NOT NULL,
      period_id BIGINT UNSIGNED NOT NULL,
      tax_type ENUM('ppn_output','ppn_input','pph','pph21_employee','pph21_non_employee','pph23','pph42') NOT NULL,
      document_number VARCHAR(100) NOT NULL,
      document_date DATE NOT NULL,
      counterparty_tax_number VARCHAR(30) NULL,
      counterparty_name VARCHAR(191) NULL,
      tax_code VARCHAR(50) NULL,
      dpp DECIMAL(20,2) NOT NULL DEFAULT 0,
      tax_amount DECIMAL(20,2) NOT NULL DEFAULT 0,
      description VARCHAR(500) NULL,
      created_by BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_tax_internal_company FOREIGN KEY(company_id) REFERENCES companies(id),
      CONSTRAINT fk_tax_internal_period FOREIGN KEY(period_id) REFERENCES tax_reconciliation_periods(id) ON DELETE CASCADE,
      CONSTRAINT fk_tax_internal_user FOREIGN KEY(created_by) REFERENCES users(id),
      INDEX idx_tax_internal_match(company_id,period_id,tax_type,document_number),
      INDEX idx_tax_internal_tax_number(company_id,counterparty_tax_number)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
    await db.query(`CREATE TABLE IF NOT EXISTS tax_document_links(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      company_id BIGINT UNSIGNED NOT NULL,
      source_key VARCHAR(100) NOT NULL,
      tax_document_number VARCHAR(100) NOT NULL,
      tax_document_date DATE NULL,
      notes VARCHAR(500) NULL,
      updated_by BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_tax_document_link(company_id,source_key),
      CONSTRAINT fk_tax_document_link_company FOREIGN KEY(company_id) REFERENCES companies(id),
      CONSTRAINT fk_tax_document_link_user FOREIGN KEY(updated_by) REFERENCES users(id),
      INDEX idx_tax_document_number(company_id,tax_document_number)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  },
  async down(db: MigrationDatabase) {
    await dropTables(db, ['tax_document_links', 'tax_internal_rows'])
    await db.query(`ALTER TABLE tax_report_rows MODIFY tax_type ENUM('ppn_output','ppn_input','pph') NOT NULL`)
  },
}
