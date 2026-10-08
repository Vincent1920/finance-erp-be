import type { MigrationDatabase } from './helpers'
export const migration = {
  name: '042_coa_governance',
  async up(db: MigrationDatabase) {
    await db.query(`CREATE TABLE IF NOT EXISTS coa_change_requests (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,company_id BIGINT UNSIGNED NOT NULL,
      kind ENUM('account','mapping') NOT NULL,target_id BIGINT UNSIGNED NULL,mapping_key VARCHAR(64) NULL,
      before_json JSON NOT NULL,after_json JSON NOT NULL,reason VARCHAR(500) NOT NULL,
      status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
      created_by BIGINT UNSIGNED NOT NULL,reviewed_by BIGINT UNSIGNED NULL,review_note VARCHAR(500) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,reviewed_at DATETIME NULL,
      INDEX coa_requests(company_id,status,id),
      FOREIGN KEY(company_id) REFERENCES companies(id),FOREIGN KEY(created_by) REFERENCES users(id),FOREIGN KEY(reviewed_by) REFERENCES users(id)
    )`)
  },
  async down() { throw new Error('Riwayat perubahan COA wajib dipertahankan') },
}
