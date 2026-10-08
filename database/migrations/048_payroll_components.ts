import { addColumnIfMissing, type MigrationDatabase } from './helpers'
export const migration = {
 name: '048_payroll_components',
 async up(db: MigrationDatabase) {
  await db.query(`CREATE TABLE IF NOT EXISTS payroll_components (
   id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, company_id BIGINT UNSIGNED NOT NULL,
   code VARCHAR(40) NOT NULL, name VARCHAR(191) NOT NULL, kind ENUM('earning','deduction') NOT NULL,
   channel ENUM('payroll','noncash','external_cash','external_noncash') NOT NULL,
   basis ENUM('nominal','attendance','overtime') NOT NULL DEFAULT 'nominal', rate DECIMAL(18,2) NOT NULL DEFAULT 0,
   taxable BOOLEAN NOT NULL DEFAULT TRUE, bpjs_base BOOLEAN NOT NULL DEFAULT FALSE,
   expense_account_id BIGINT UNSIGNED NULL, contra_account_id BIGINT UNSIGNED NULL,
   effective_from DATE NOT NULL, effective_to DATE NULL, policy_reference VARCHAR(500) NOT NULL,
   is_active BOOLEAN NOT NULL DEFAULT TRUE, version INT NOT NULL DEFAULT 1,
   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
   UNIQUE KEY uq_payroll_component(company_id,code), KEY ix_component_period(company_id,effective_from))`)
  await db.query(`CREATE TABLE IF NOT EXISTS payroll_entry_components (
   id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, entry_id BIGINT UNSIGNED NOT NULL,
   component_id BIGINT UNSIGNED NOT NULL, snapshot JSON NOT NULL,
   quantity DECIMAL(10,2) NOT NULL, amount DECIMAL(18,2) NOT NULL, taxable_amount DECIMAL(18,2) NOT NULL,
   source_journal_id BIGINT UNSIGNED NULL, source_reference VARCHAR(191) NULL,
   KEY ix_component_entry(entry_id), KEY ix_component_source(source_journal_id),
   FOREIGN KEY(entry_id) REFERENCES payroll_entries(id) ON DELETE CASCADE,
   FOREIGN KEY(component_id) REFERENCES payroll_components(id) ON DELETE RESTRICT)`)
  for (const name of ['planned_days','present_days','paid_leave_days','sick_days','absent_days','overtime_hours'])
   await addColumnIfMissing(db,'payroll_entries',name,'DECIMAL(10,2) NOT NULL DEFAULT 0')
  for (const name of ['cash_earnings','noncash_earnings','external_earnings','custom_earnings','custom_deductions','bpjs_salary_base'])
   await addColumnIfMissing(db,'payroll_entries',name,'DECIMAL(18,2) NOT NULL DEFAULT 0')
  await addColumnIfMissing(db,'payroll_entries','reimbursement_taxable','BOOLEAN NOT NULL DEFAULT TRUE')
  await addColumnIfMissing(db,'payroll_entries','absence_reduces_tax','BOOLEAN NOT NULL DEFAULT FALSE')
  await db.query('UPDATE payroll_entries SET cash_earnings=gross_earnings,bpjs_salary_base=basic_salary+fixed_allowance')
 },
 async down() { throw new Error('Payroll component history must be preserved') },
}
