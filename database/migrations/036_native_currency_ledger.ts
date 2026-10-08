import { addColumnIfMissing, type MigrationDatabase } from './helpers'
export const migration = {
  name: '036_native_currency_ledger',
  async up(db: MigrationDatabase) {
    await addColumnIfMissing(db, 'journal_lines', 'currency_code', 'CHAR(3) NULL')
  },
  async down() {
    throw new Error('Restore a verified backup to roll back native currency ledger metadata')
  },
}
