import type { MigrationDatabase } from './helpers'
export const migration = {name:'038_user_preferences', async up(db:MigrationDatabase) {
  await db.query(`CREATE TABLE IF NOT EXISTS user_preferences (company_id BIGINT UNSIGNED NOT NULL,user_id BIGINT UNSIGNED NOT NULL,preference_key VARCHAR(100) NOT NULL,value_json JSON NOT NULL,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,PRIMARY KEY(company_id,user_id,preference_key))`)
},async down(){throw new Error('Restore a verified backup to roll back user preferences')}}
