import { addColumnIfMissing, type MigrationDatabase } from './helpers'

export const migration = {
  name: '034_invoice_control_snapshot',
  async up(db: MigrationDatabase) {
    for (const [table, side] of [
      ['sales_invoices', 'debit'],
      ['purchase_invoices', 'credit'],
    ] as const) {
      await addColumnIfMissing(db, table, 'control_account_id', 'BIGINT UNSIGNED NULL')
      // Recover only an unambiguous account from the original journal, never today's master.
      await db.query(`UPDATE ${table} i JOIN (
        SELECT i2.id, MIN(l.account_id) account_id FROM ${table} i2
        JOIN journal_lines l ON l.journal_id=i2.journal_id
        WHERE l.${side}=i2.base_grand_total AND l.${side}>0
        GROUP BY i2.id HAVING COUNT(*)=1
      ) original ON original.id=i.id SET i.control_account_id=original.account_id
      WHERE i.control_account_id IS NULL`)
    }
  },
  async down(db: MigrationDatabase) {
    await db.query('ALTER TABLE sales_invoices DROP COLUMN control_account_id')
    await db.query('ALTER TABLE purchase_invoices DROP COLUMN control_account_id')
  },
}
