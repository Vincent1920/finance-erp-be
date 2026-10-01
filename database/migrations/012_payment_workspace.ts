import type { MigrationDatabase } from './helpers'
import { addColumnIfMissing, dropColumnIfExists } from './helpers'

const paymentTables = ['customer_payments', 'supplier_payments'] as const

export const migration = {
  name: '012_payment_workspace',
  async up(db: MigrationDatabase) {
    for (const table of paymentTables) {
      await addColumnIfMissing(db, table, 'deleted_at', 'DATETIME NULL')
      await addColumnIfMissing(db, table, 'deleted_by', 'BIGINT UNSIGNED NULL')
    }
  },
  async down(db: MigrationDatabase) {
    for (const table of paymentTables) {
      await dropColumnIfExists(db, table, 'deleted_by')
      await dropColumnIfExists(db, table, 'deleted_at')
    }
  },
}
