import type { MigrationDatabase } from './helpers'

export const migration = {
  name: '028_reconciliation_workspace',
  async up(db: MigrationDatabase) {
    await db.query(`CREATE TABLE IF NOT EXISTS reconciliation_cases(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      company_id BIGINT UNSIGNED NOT NULL,
      as_of_date DATE NOT NULL,
      reconciliation_type VARCHAR(50) NOT NULL,
      account_id BIGINT UNSIGNED NOT NULL,
      status ENUM('open','in_review','resolved','accepted_variance') NOT NULL DEFAULT 'open',
      assigned_to BIGINT UNSIGNED NULL,
      due_date DATE NULL,
      resolution_note TEXT NULL,
      created_by BIGINT UNSIGNED NOT NULL,
      updated_by BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_reconciliation_case(company_id,as_of_date,reconciliation_type,account_id),
      CONSTRAINT fk_reconciliation_case_company FOREIGN KEY(company_id) REFERENCES companies(id),
      CONSTRAINT fk_reconciliation_case_account FOREIGN KEY(account_id) REFERENCES accounts(id),
      CONSTRAINT fk_reconciliation_case_assignee FOREIGN KEY(assigned_to) REFERENCES users(id) ON DELETE SET NULL,
      CONSTRAINT fk_reconciliation_case_creator FOREIGN KEY(created_by) REFERENCES users(id),
      CONSTRAINT fk_reconciliation_case_updater FOREIGN KEY(updated_by) REFERENCES users(id),
      INDEX idx_reconciliation_case_queue(company_id,status,due_date,assigned_to)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

    await db.query(`CREATE TABLE IF NOT EXISTS reconciliation_case_activities(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      company_id BIGINT UNSIGNED NOT NULL,
      case_id BIGINT UNSIGNED NOT NULL,
      action ENUM('created','updated','commented','assigned','status_changed') NOT NULL,
      previous_status VARCHAR(30) NULL,
      new_status VARCHAR(30) NULL,
      note TEXT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_reconciliation_activity_company FOREIGN KEY(company_id) REFERENCES companies(id),
      CONSTRAINT fk_reconciliation_activity_case FOREIGN KEY(case_id) REFERENCES reconciliation_cases(id) ON DELETE CASCADE,
      CONSTRAINT fk_reconciliation_activity_user FOREIGN KEY(user_id) REFERENCES users(id),
      INDEX idx_reconciliation_activity(case_id,created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

    await db.query(`INSERT IGNORE INTO permissions(module,action,name,slug)
      VALUES ('reports','reconcile','Kelola tindak lanjut rekonsiliasi','reports.reconcile')`)
    await db.query(`INSERT IGNORE INTO role_permissions(role_id,permission_id)
      SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
       WHERE r.slug='super-admin' AND p.slug='reports.reconcile'`)
  },
  async down(db: MigrationDatabase) {
    await db.query(`DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE p.slug='reports.reconcile'`)
    await db.query(`DELETE FROM permissions WHERE slug='reports.reconcile'`)
    await db.query('DROP TABLE IF EXISTS reconciliation_case_activities')
    await db.query('DROP TABLE IF EXISTS reconciliation_cases')
  },
}
