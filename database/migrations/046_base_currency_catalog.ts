import type { MigrationDatabase } from './helpers'
export const migration = {
  name: '046_base_currency_catalog',
  async up(db: MigrationDatabase) {
    await db.query("INSERT IGNORE INTO currencies(code,name,symbol,is_active) VALUES('IDR','Indonesian Rupiah','Rp',TRUE)")
    await db.query(`INSERT IGNORE INTO currencies(code,name,symbol,is_active)
      SELECT DISTINCT base_currency,base_currency,base_currency,TRUE FROM companies
      WHERE base_currency IS NOT NULL AND CHAR_LENGTH(base_currency)=3`)
  },
  async down() { throw new Error('Master mata uang pembukuan harus dipertahankan') },
}
