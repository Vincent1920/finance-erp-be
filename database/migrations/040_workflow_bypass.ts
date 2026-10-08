import type { MigrationDatabase } from './helpers'
export const migration = {
  name: '040_workflow_bypass',
  async up(db: MigrationDatabase) {
    await db.query(`INSERT INTO settings(company_id,setting_key,setting_value,value_type,category,is_secret) SELECT id,'accounting.bypass_workflow','false','boolean','accounting',0 FROM companies ON DUPLICATE KEY UPDATE setting_key=VALUES(setting_key)`)
  },
  async down() { throw new Error('Disable the workflow setting instead of deleting its audit history') },
}
