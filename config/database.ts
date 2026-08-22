import mysql, { type PoolConnection, type RowDataPacket } from 'mysql2/promise'
import { env } from './env'
export const db = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  decimalNumbers: true,
  timezone: 'Z',
  charset: 'utf8mb4',
  multipleStatements: true,
})
export async function transaction<T>(work: (connection: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await db.getConnection()
  try {
    await connection.beginTransaction()
    const result = await work(connection)
    await connection.commit()
    return result
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}
export async function databaseStatus() {
  try {
    const [rows] = await db.query<RowDataPacket[]>('SELECT 1 AS ok')
    return rows[0]?.ok === 1
  } catch {
    return false
  }
}
