import type { MigrationDatabase } from './helpers'
export const migration = {
  name: '039_report_exports',
  async up(db: MigrationDatabase) {
    await db.query(`CREATE TABLE IF NOT EXISTS report_exports (
      id CHAR(36) PRIMARY KEY, company_id BIGINT UNSIGNED NOT NULL, user_id BIGINT UNSIGNED NOT NULL,
      report_type VARCHAR(40) NOT NULL, format VARCHAR(8) NOT NULL, filters_json JSON NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'queued', row_count INT NOT NULL DEFAULT 0,
      snapshot_at DATETIME NULL, filename VARCHAR(180) NULL, output LONGBLOB NULL,
      error_message VARCHAR(255) NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL, INDEX export_owner(company_id,user_id,created_at), INDEX export_queue(status,created_at)
    )`)
  },
  async down() { throw new Error('Restore a verified backup to roll back report exports') },
}
