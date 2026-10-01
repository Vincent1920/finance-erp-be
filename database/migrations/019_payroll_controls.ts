import type { MigrationDatabase } from './helpers'
import { addColumnIfMissing, addForeignKeyIfMissing, addIndexIfMissing, dropColumnIfExists, dropForeignKeyIfExists, dropIndexIfExists } from './helpers'

export const migration = {
  name: '019_payroll_controls',
  async up(db: MigrationDatabase) {
    await addColumnIfMissing(db, 'payroll_policies', 'health_wage_floor', 'DECIMAL(20,2) NOT NULL DEFAULT 0')
    await addColumnIfMissing(db, 'payroll_policies', 'source_reference', 'VARCHAR(500) NULL')
    await addColumnIfMissing(db, 'payroll_policies', 'policy_notes', 'VARCHAR(1000) NULL')
    await addColumnIfMissing(db, 'payroll_runs', 'policy_id', 'BIGINT UNSIGNED NULL')
    await addColumnIfMissing(db, 'payroll_runs', 'calculation_version', "VARCHAR(30) NULL")
    await addColumnIfMissing(db, 'payroll_runs', 'calculated_at', 'DATETIME NULL')
    await addColumnIfMissing(db, 'payroll_entries', 'pph21_override_reason', 'VARCHAR(500) NULL')
    await addIndexIfMissing(db, 'payroll_runs', 'idx_payroll_run_policy', 'INDEX idx_payroll_run_policy(policy_id)')
    await addForeignKeyIfMissing(db, 'payroll_runs', 'fk_payroll_run_policy', 'FOREIGN KEY(policy_id) REFERENCES payroll_policies(id)')
  },
  async down(db: MigrationDatabase) {
    await dropForeignKeyIfExists(db, 'payroll_runs', 'fk_payroll_run_policy')
    await dropIndexIfExists(db, 'payroll_runs', 'idx_payroll_run_policy')
    await dropColumnIfExists(db, 'payroll_entries', 'pph21_override_reason')
    for (const column of ['calculated_at', 'calculation_version', 'policy_id']) await dropColumnIfExists(db, 'payroll_runs', column)
    for (const column of ['policy_notes', 'source_reference', 'health_wage_floor']) await dropColumnIfExists(db, 'payroll_policies', column)
  },
}
