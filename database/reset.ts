import type { RowDataPacket } from 'mysql2'
import { env } from '../config/env'
if (env.APP_ENV !== 'development')
  throw new Error('db:reset hanya boleh dijalankan pada APP_ENV=development')
console.warn('PERINGATAN: seluruh tabel Finance ERP akan dihapus.')
const { db } = await import('../config/database')
const [rows] = await db.query<(RowDataPacket & { TABLE_NAME: string })[]>(
  'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=?',
  [env.DB_NAME],
)
await db.query('SET FOREIGN_KEY_CHECKS=0')
for (const row of rows) await db.query(`DROP TABLE \`${row.TABLE_NAME}\``)
await db.query('SET FOREIGN_KEY_CHECKS=1')
await db.end()
console.log('Database reset. Jalankan bun run migrate lalu bun run db:seed.')
