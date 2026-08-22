import type { RowDataPacket } from 'mysql2'

import { db } from '../config/database'
import { migrations } from './migrations'

await db.query(
  `CREATE TABLE IF NOT EXISTS migrations (
     id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
     name VARCHAR(191) NOT NULL UNIQUE,
     run_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
   ) ENGINE=InnoDB`,
)

const [rows] = await db.query<(RowDataPacket & { name: string })[]>('SELECT name FROM migrations')
const completedMigrations = new Set(rows.map((row) => row.name))

for (const migration of migrations) {
  if (completedMigrations.has(migration.name)) {
    continue
  }

  console.log(`Migrating ${migration.name}...`)
  await migration.up(db)
  await db.execute('INSERT INTO migrations (name) VALUES (?)', [migration.name])
}

console.log('Migration complete')
await db.end()
