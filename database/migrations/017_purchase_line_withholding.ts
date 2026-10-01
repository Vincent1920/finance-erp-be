import type { MigrationDatabase } from './helpers'
import {
  addColumnIfMissing,
  addForeignKeyIfMissing,
  addIndexIfMissing,
  dropColumnIfExists,
  dropForeignKeyIfExists,
  dropIndexIfExists,
} from './helpers'

export const migration = {
  name: '017_purchase_line_withholding',
  async up(db: MigrationDatabase) {
    await addColumnIfMissing(
      db,
      'purchase_invoice_lines',
      'withholding_tax_id',
      'BIGINT UNSIGNED NULL',
    )
    await addColumnIfMissing(
      db,
      'purchase_invoice_lines',
      'withholding_rate',
      'DECIMAL(9,4) NOT NULL DEFAULT 0',
    )
    await addColumnIfMissing(
      db,
      'purchase_invoice_lines',
      'withholding_amount',
      'DECIMAL(20,2) NOT NULL DEFAULT 0',
    )
    await addColumnIfMissing(
      db,
      'purchase_invoice_lines',
      'base_withholding_amount',
      'DECIMAL(20,2) NOT NULL DEFAULT 0',
    )
    await addColumnIfMissing(
      db,
      'purchase_invoice_lines',
      'withholding_account_id',
      'BIGINT UNSIGNED NULL',
    )
    await addIndexIfMissing(
      db,
      'purchase_invoice_lines',
      'idx_pi_line_withholding_tax',
      'INDEX idx_pi_line_withholding_tax(withholding_tax_id)',
    )
    await addForeignKeyIfMissing(
      db,
      'purchase_invoice_lines',
      'fk_pi_line_withholding_tax',
      'FOREIGN KEY(withholding_tax_id) REFERENCES tax_codes(id)',
    )
    await addForeignKeyIfMissing(
      db,
      'purchase_invoice_lines',
      'fk_pi_line_withholding_account',
      'FOREIGN KEY(withholding_account_id) REFERENCES accounts(id)',
    )

    // Preserve invoices created before withholding was moved to the line level.
    await db.query(`UPDATE purchase_invoice_lines l
      JOIN purchase_invoices h ON h.id=l.purchase_invoice_id
      JOIN tax_codes tc ON tc.id=h.withholding_tax_id
      SET l.withholding_tax_id=h.withholding_tax_id,
          l.withholding_rate=tc.rate,
          l.withholding_amount=ROUND(l.subtotal*tc.rate/100,2),
          l.base_withholding_amount=ROUND(l.base_subtotal*tc.rate/100,2),
          l.withholding_account_id=h.withholding_account_id
      WHERE h.withholding_tax_id IS NOT NULL AND h.withholding_amount<>0`)
  },
  async down(db: MigrationDatabase) {
    await dropForeignKeyIfExists(db, 'purchase_invoice_lines', 'fk_pi_line_withholding_account')
    await dropForeignKeyIfExists(db, 'purchase_invoice_lines', 'fk_pi_line_withholding_tax')
    await dropIndexIfExists(db, 'purchase_invoice_lines', 'idx_pi_line_withholding_tax')
    for (const column of [
      'withholding_account_id',
      'base_withholding_amount',
      'withholding_amount',
      'withholding_rate',
      'withholding_tax_id',
    ])
      await dropColumnIfExists(db, 'purchase_invoice_lines', column)
  },
}
