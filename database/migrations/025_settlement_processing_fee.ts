import type { MigrationDatabase } from './helpers'
import { addColumnIfMissing, addForeignKeyIfMissing, dropColumnIfExists, dropForeignKeyIfExists } from './helpers'

const tables = ['customer_payments', 'supplier_payments'] as const

export const migration = {
  name: '025_settlement_processing_fee',
  async up(db: MigrationDatabase) {
    for (const table of tables) {
      await db.query(`ALTER TABLE ${table} MODIFY payment_method ENUM('cash','bank_transfer','check','card','qris','payment_gateway','other') NOT NULL`)
      await addColumnIfMissing(db, table, 'processing_fee_rate', "DECIMAL(9,4) NOT NULL DEFAULT 0 AFTER base_amount")
      await addColumnIfMissing(db, table, 'processing_fee_amount', "DECIMAL(20,2) NOT NULL DEFAULT 0 AFTER processing_fee_rate")
      await addColumnIfMissing(db, table, 'base_processing_fee_amount', "DECIMAL(20,2) NOT NULL DEFAULT 0 AFTER processing_fee_amount")
      await addColumnIfMissing(db, table, 'bank_amount', "DECIMAL(20,2) NOT NULL DEFAULT 0 AFTER base_processing_fee_amount")
      await addColumnIfMissing(db, table, 'base_bank_amount', "DECIMAL(20,2) NOT NULL DEFAULT 0 AFTER bank_amount")
      await addColumnIfMissing(db, table, 'processing_fee_account_id', "BIGINT UNSIGNED NULL AFTER cash_account_id")
      await db.query(`UPDATE ${table} SET bank_amount=amount,base_bank_amount=base_amount WHERE bank_amount=0 AND amount>0`)
      await addForeignKeyIfMissing(
        db,
        table,
        `fk_${table}_processing_fee_account`,
        'FOREIGN KEY(processing_fee_account_id) REFERENCES accounts(id)',
      )
    }
  },
  async down(db: MigrationDatabase) {
    for (const table of [...tables].reverse()) {
      await db.query(`UPDATE ${table} SET payment_method='other' WHERE payment_method IN ('qris','payment_gateway')`)
      await db.query(`ALTER TABLE ${table} MODIFY payment_method ENUM('cash','bank_transfer','check','card','other') NOT NULL`)
      await dropForeignKeyIfExists(db, table, `fk_${table}_processing_fee_account`)
      for (const column of ['processing_fee_account_id', 'base_bank_amount', 'bank_amount', 'base_processing_fee_amount', 'processing_fee_amount', 'processing_fee_rate'])
        await dropColumnIfExists(db, table, column)
    }
  },
}
