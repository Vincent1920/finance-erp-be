import type { MigrationDatabase } from './helpers'
export const migration={
  name:'043_accounting_date_policy',
  async up(db:MigrationDatabase){
    for(const [key,value,type] of [
      ['accounting.transaction_lock_date','','string'],
      ['accounting.max_backdate_days','0','number'],
      ['accounting.allow_future_dates','true','boolean'],
      ['accounting.posting_timezone','Asia/Jakarta','string'],
    ])await db.query(`INSERT INTO settings(company_id,setting_key,setting_value,value_type,category,is_secret) SELECT id,'${key}','${value}','${type}','accounting',0 FROM companies ON DUPLICATE KEY UPDATE setting_key=VALUES(setting_key)`)
  },async down(){throw new Error('Kebijakan dan histori akuntansi wajib dipertahankan')}
}
