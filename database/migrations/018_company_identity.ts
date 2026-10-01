import type { MigrationDatabase } from './helpers'

export const migration = {
  name: '018_company_identity',
  up: async (db: MigrationDatabase) => {
    await db.query('ALTER TABLE companies MODIFY logo MEDIUMTEXT NULL')
  },
  down: async (db: MigrationDatabase) => {
    await db.query("UPDATE companies SET logo=NULL WHERE CHAR_LENGTH(COALESCE(logo,''))>255")
    await db.query('ALTER TABLE companies MODIFY logo VARCHAR(255) NULL')
  },
}
