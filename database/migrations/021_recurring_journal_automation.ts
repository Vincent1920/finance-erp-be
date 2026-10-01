import type { MigrationDatabase } from './helpers'
import { addColumnIfMissing, dropColumnIfExists } from './helpers'

export const migration = {
  name: '021_recurring_journal_automation',
  async up(db: MigrationDatabase) {
    await addColumnIfMissing(
      db,
      'recurring_journals',
      'auto_submit',
      'BOOLEAN NOT NULL DEFAULT FALSE AFTER exchange_rate',
    )
  },
  async down(db: MigrationDatabase) {
    await dropColumnIfExists(db, 'recurring_journals', 'auto_submit')
  },
}
