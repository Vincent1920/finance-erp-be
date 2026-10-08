import 'dotenv/config'
import mysql from 'mysql2/promise'
if (process.env.APP_ENV === 'production') throw new Error('Development-only verification')
const schema = `finora_foundation_${Date.now()}_${Math.floor(Math.random()*100000)}`
const admin = await mysql.createConnection({host:process.env.DB_HOST,port:Number(process.env.DB_PORT),user:process.env.DB_USER,password:process.env.DB_PASSWORD})
try {
  await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  process.env.DB_NAME = schema
  const {db} = await import('../config/database')
  try {const {migrations} = await import('./migrations'); for (const m of migrations) await m.up(db)} finally {await db.end()}
  for (const file of ['tests/equity.integration.test.ts','tests/opening-foundation.integration.test.ts','tests/report-foundation.integration.test.ts']) {
    const child = Bun.spawn(['bun','test',file], {env:{...process.env,DB_NAME:schema,RUN_EQUITY_DB_TESTS:'1',RUN_FOUNDATION_DB_TESTS:'1'},stdout:'inherit',stderr:'inherit'})
    const code = await child.exited
    if(code) throw new Error(`Foundation tests failed (${code})`)
  }
} finally {
  if(!/^finora_foundation_\d+_\d+$/.test(schema)) throw new Error('Unsafe cleanup target')
  await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``)
  await admin.end()
}
