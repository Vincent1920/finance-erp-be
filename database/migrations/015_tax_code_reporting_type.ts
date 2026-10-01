import type { MigrationDatabase } from './helpers'

export const migration = {
  name: '015_tax_code_reporting_type',
  async up(db: MigrationDatabase) {
    await db.query(`ALTER TABLE tax_codes ADD COLUMN reporting_type
      ENUM('ppn','pph21_employee','pph21_non_employee','pph23','pph42','other') NULL AFTER tax_type`)
    await db.query(`UPDATE tax_codes SET reporting_type=CASE
      WHEN tax_type='vat' THEN 'ppn'
      WHEN UPPER(CONCAT(code,' ',name)) LIKE '%PPh 21%' OR UPPER(code) LIKE '%PPH21%' THEN 'pph21_non_employee'
      WHEN UPPER(CONCAT(code,' ',name)) LIKE '%4(2)%' OR UPPER(code) LIKE '%PPH42%' OR UPPER(CONCAT(code,' ',name)) LIKE '%FINAL%' THEN 'pph42'
      WHEN tax_type='withholding' THEN 'pph23'
      ELSE 'other' END WHERE reporting_type IS NULL`)
  },
  async down(db: MigrationDatabase) {
    await db.query('ALTER TABLE tax_codes DROP COLUMN reporting_type')
  },
}
