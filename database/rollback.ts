import type { RowDataPacket } from 'mysql2'
import { db } from '../config/database'
import { migrations } from './migrations'
const [rows] = await db.query<(RowDataPacket & { name: string })[]>(
  'SELECT name FROM migrations ORDER BY id DESC LIMIT 1',
)
const name = rows[0]?.name
if (!name) console.log('Nothing to rollback')
else {
  const migration = migrations.find((x) => x.name === name)
  if (!migration) throw new Error(`Migration ${name} tidak ditemukan`)
  await db.query('SET FOREIGN_KEY_CHECKS=0')
  await migration.down(db)
  await db.execute('DELETE FROM migrations WHERE name=?', [name])
  await db.query('SET FOREIGN_KEY_CHECKS=1')
  console.log(`Rolled back ${name}`)
}
await db.end()
