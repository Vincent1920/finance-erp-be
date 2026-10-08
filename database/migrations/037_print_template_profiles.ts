import type { MigrationDatabase } from './helpers'

export const migration = {
  name: '037_print_template_profiles',
  async up(db: MigrationDatabase) {
    // Named templates may include multiple embedded QR images; TEXT only holds 64 KB.
    await db.query('ALTER TABLE settings MODIFY COLUMN setting_value LONGTEXT NULL')
  },
  async down() {
    throw new Error('Restore a verified backup to avoid truncating saved document designs')
  },
}
