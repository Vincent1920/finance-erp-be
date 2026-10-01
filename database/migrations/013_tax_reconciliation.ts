import type { MigrationDatabase } from './helpers'
import { dropTables } from './helpers'

export const migration = {
  name: '013_tax_reconciliation',
  async up(db: MigrationDatabase) {
    await db.query(`CREATE TABLE IF NOT EXISTS tax_reconciliation_periods(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      company_id BIGINT UNSIGNED NOT NULL,
      tax_period CHAR(7) NOT NULL,
      revision INT UNSIGNED NOT NULL DEFAULT 0,
      status ENUM('open','reviewed','locked') NOT NULL DEFAULT 'open',
      source_file VARCHAR(255) NULL,
      notes TEXT NULL,
      imported_by BIGINT UNSIGNED NULL,
      imported_at DATETIME NULL,
      reviewed_by BIGINT UNSIGNED NULL,
      reviewed_at DATETIME NULL,
      locked_by BIGINT UNSIGNED NULL,
      locked_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_tax_reconciliation_period(company_id,tax_period),
      CONSTRAINT fk_tax_recon_period_company FOREIGN KEY(company_id) REFERENCES companies(id),
      CONSTRAINT fk_tax_recon_period_imported FOREIGN KEY(imported_by) REFERENCES users(id) ON DELETE SET NULL,
      CONSTRAINT fk_tax_recon_period_reviewed FOREIGN KEY(reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
      CONSTRAINT fk_tax_recon_period_locked FOREIGN KEY(locked_by) REFERENCES users(id) ON DELETE SET NULL,
      INDEX idx_tax_recon_period_status(company_id,status,tax_period)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

    await db.query(`CREATE TABLE IF NOT EXISTS tax_report_rows(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      company_id BIGINT UNSIGNED NOT NULL,
      period_id BIGINT UNSIGNED NOT NULL,
      tax_type ENUM('ppn_output','ppn_input','pph') NOT NULL,
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
      CONSTRAINT fk_tax_report_row_company FOREIGN KEY(company_id) REFERENCES companies(id),
      CONSTRAINT fk_tax_report_row_period FOREIGN KEY(period_id) REFERENCES tax_reconciliation_periods(id) ON DELETE CASCADE,
      CONSTRAINT fk_tax_report_row_user FOREIGN KEY(created_by) REFERENCES users(id),
      INDEX idx_tax_report_match(company_id,period_id,tax_type,document_number),
      INDEX idx_tax_report_tax_number(company_id,counterparty_tax_number)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

    await db.query(`CREATE TABLE IF NOT EXISTS tax_reconciliation_resolutions(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      company_id BIGINT UNSIGNED NOT NULL,
      period_id BIGINT UNSIGNED NOT NULL,
      match_key VARCHAR(255) NOT NULL,
      resolution_code ENUM('pending','timing','non_taxable','return_or_cancel','data_correction','spt_correction','accepted_difference') NOT NULL DEFAULT 'pending',
      note VARCHAR(1000) NULL,
      resolved_by BIGINT UNSIGNED NOT NULL,
      resolved_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_tax_resolution(company_id,period_id,match_key),
      CONSTRAINT fk_tax_resolution_company FOREIGN KEY(company_id) REFERENCES companies(id),
      CONSTRAINT fk_tax_resolution_period FOREIGN KEY(period_id) REFERENCES tax_reconciliation_periods(id) ON DELETE CASCADE,
      CONSTRAINT fk_tax_resolution_user FOREIGN KEY(resolved_by) REFERENCES users(id),
      INDEX idx_tax_resolution_period(company_id,period_id,resolution_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

    await db.query(`INSERT IGNORE INTO permissions(module,action,name,slug)
      SELECT 'tax-reconciliation',a.action,CONCAT(a.action,' tax-reconciliation'),CONCAT('tax-reconciliation.',a.action)
      FROM (SELECT 'view' action UNION ALL SELECT 'import' UNION ALL SELECT 'update' UNION ALL SELECT 'lock' UNION ALL SELECT 'export') a`)
    await db.query(`INSERT IGNORE INTO role_permissions(role_id,permission_id)
      SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
      WHERE r.slug='super-admin' AND p.module='tax-reconciliation'`)
  },
  async down(db: MigrationDatabase) {
    await db.query(`DELETE rp FROM role_permissions rp INNER JOIN permissions p ON p.id=rp.permission_id WHERE p.module='tax-reconciliation'`)
    await db.query(`DELETE FROM permissions WHERE module='tax-reconciliation'`)
    await dropTables(db, [
      'tax_reconciliation_resolutions',
      'tax_report_rows',
      'tax_reconciliation_periods',
    ])
  },
}
