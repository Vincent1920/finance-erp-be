import { createHash } from 'node:crypto'
import type { RowDataPacket } from 'mysql2/promise'
import { transaction } from '../config/database'
import type { QueryExecutor } from '../types/database'
import { ConflictError } from '../utils/AppError'
export async function idempotentOperation<T>(
  companyId: number,
  key: string,
  operation: string,
  payload: unknown,
  work: (connection: QueryExecutor) => Promise<T>,
): Promise<T> {
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  return transaction(async (connection) => {
    await connection.execute(
      `INSERT INTO operation_requests(company_id,request_key,operation,payload_hash) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE request_key=request_key`,
      [companyId, key, operation, hash],
    )
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT operation,payload_hash,result FROM operation_requests WHERE company_id=? AND request_key=? FOR UPDATE',
      [companyId, key],
    )
    const row = rows[0]!
    if (row.operation !== operation || row.payload_hash !== hash)
      throw new ConflictError('Permintaan sudah digunakan untuk data berbeda. Muat ulang formulir.')
    if (row.result)
      return (typeof row.result === 'string' ? JSON.parse(row.result) : row.result) as T
    const result = await work(connection)
    await connection.execute(
      'UPDATE operation_requests SET result=? WHERE company_id=? AND request_key=?',
      [JSON.stringify(result), companyId, key],
    )
    return result
  })
}
