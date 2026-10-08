import type { MigrationDatabase } from './helpers'
import { addColumnIfMissing, dropColumnIfExists } from './helpers'

export const migration = {
  name: '029_reconciliation_case_snapshot',
  async up(db: MigrationDatabase) {
    await addColumnIfMissing(db, 'reconciliation_cases', 'general_ledger_amount', 'DECIMAL(20,2) NOT NULL DEFAULT 0 AFTER account_id')
    await addColumnIfMissing(db, 'reconciliation_cases', 'subledger_amount', 'DECIMAL(20,2) NOT NULL DEFAULT 0 AFTER general_ledger_amount')
    await addColumnIfMissing(db, 'reconciliation_cases', 'difference_amount', 'DECIMAL(20,2) NOT NULL DEFAULT 0 AFTER subledger_amount')
  },
  async down(db: MigrationDatabase) {
    for (const column of ['difference_amount', 'subledger_amount', 'general_ledger_amount'])
      await dropColumnIfExists(db, 'reconciliation_cases', column)
  },
}
