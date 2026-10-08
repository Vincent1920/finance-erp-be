import type { MigrationDatabase } from './helpers'
import { addColumnIfMissing, addForeignKeyIfMissing, dropColumnIfExists, dropForeignKeyIfExists } from './helpers'

export const migration = {
  name: '027_payroll_employee_status',
  async up(db: MigrationDatabase) {
    await addColumnIfMissing(db, 'payroll_employees', 'status_reason', 'VARCHAR(500) NULL AFTER is_active')
    await addColumnIfMissing(db, 'payroll_employees', 'status_changed_at', 'DATETIME NULL AFTER status_reason')
    await addColumnIfMissing(db, 'payroll_employees', 'status_changed_by', 'BIGINT UNSIGNED NULL AFTER status_changed_at')
    await addForeignKeyIfMissing(db, 'payroll_employees', 'fk_payroll_employee_status_user', 'FOREIGN KEY(status_changed_by) REFERENCES users(id)')
  },
  async down(db: MigrationDatabase) {
    await dropForeignKeyIfExists(db, 'payroll_employees', 'fk_payroll_employee_status_user')
    for (const column of ['status_changed_by', 'status_changed_at', 'status_reason'])
      await dropColumnIfExists(db, 'payroll_employees', column)
  },
}
