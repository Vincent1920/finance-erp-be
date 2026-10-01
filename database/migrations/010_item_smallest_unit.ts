import {
  addColumnIfMissing,
  addForeignKeyIfMissing,
  dropColumnIfExists,
  dropForeignKeyIfExists,
  type MigrationDatabase,
} from './helpers'
export const migration = {
  name: '010_item_smallest_unit',
  async up(db: MigrationDatabase) {
    await addColumnIfMissing(db, 'items', 'smallest_unit_id', 'BIGINT UNSIGNED NULL')
    await addColumnIfMissing(db, 'items', 'smallest_unit_factor', 'INT UNSIGNED NOT NULL DEFAULT 1')
    await addForeignKeyIfMissing(
      db,
      'items',
      'fk_item_smallest_unit',
      'FOREIGN KEY(smallest_unit_id) REFERENCES units(id)',
    )
  },
  async down(db: MigrationDatabase) {
    await dropForeignKeyIfExists(db, 'items', 'fk_item_smallest_unit')
    await dropColumnIfExists(db, 'items', 'smallest_unit_id')
    await dropColumnIfExists(db, 'items', 'smallest_unit_factor')
  },
}
