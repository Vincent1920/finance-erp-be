import type { RowDataPacket } from 'mysql2'
import { db } from '../config/database'
import type { DatabaseValue, QueryExecutor } from '../types/database'
import { pagination } from '../utils/pagination'

type LogQuery = {
  page?: string
  limit?: string
  search?: string
  module?: string
  action?: string
  level?: string
  resolved?: string
  date_from?: string
  date_to?: string
  request_id?: string
  user_id?: string
}

function dateFilters(query: LogQuery, conditions: string[], values: DatabaseValue[], alias: string) {
  if (query.date_from) {
    conditions.push(`${alias}.created_at >= ?`)
    values.push(`${query.date_from} 00:00:00`)
  }
  if (query.date_to) {
    conditions.push(`${alias}.created_at <= ?`)
    values.push(`${query.date_to} 23:59:59`)
  }
}

export class LogRepository {
  async auditList(companyId: number, query: LogQuery) {
    const { page, limit, offset } = pagination(query.page, query.limit)
    const conditions = ['a.company_id = ?']
    const values: DatabaseValue[] = [companyId]
    if (query.search) {
      conditions.push(
        "CONCAT(a.module, ' ', a.action, ' ', COALESCE(a.record_type, ''), ' ', COALESCE(a.record_number, '')) LIKE ?",
      )
      values.push(`%${query.search.trim()}%`)
    }
    if (query.module) {
      conditions.push('a.module = ?')
      values.push(query.module)
    }
    if (query.action) {
      conditions.push('a.action = ?')
      values.push(query.action)
    }
    if (query.request_id) {
      conditions.push('a.request_id = ?')
      values.push(query.request_id)
    }
    if (query.user_id && Number.isSafeInteger(Number(query.user_id))) {
      conditions.push('a.user_id = ?')
      values.push(Number(query.user_id))
    }
    dateFilters(query, conditions, values, 'a')
    const where = conditions.join(' AND ')
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT a.id, a.user_id, u.name AS user_name, a.module, a.action,
              a.record_type, a.record_id, a.record_number, a.ip, a.request_id,
              a.request_method, a.request_path, a.created_at
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE ${where}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ? OFFSET ?`,
      [...values, limit, offset],
    )
    const [count] = await db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM audit_logs a WHERE ${where}`,
      values,
    )
    return { rows, total: Number(count[0]?.total ?? 0), page, limit }
  }

  async auditFind(id: number, companyId: number) {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT a.*, u.name AS user_name, u.email AS user_email
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.id = ? AND a.company_id = ? LIMIT 1`,
      [id, companyId],
    )
    return rows[0] ?? null
  }

  async errorList(companyId: number, query: LogQuery) {
    const { page, limit, offset } = pagination(query.page, query.limit)
    const conditions = ['e.company_id = ?']
    const values: DatabaseValue[] = [companyId]
    if (query.search) {
      conditions.push(
        "CONCAT(e.category, ' ', e.message, ' ', COALESCE(e.error_code, ''), ' ', COALESCE(e.request_id, '')) LIKE ?",
      )
      values.push(`%${query.search.trim()}%`)
    }
    if (query.level && ['error', 'warn', 'info'].includes(query.level)) {
      conditions.push('e.level = ?')
      values.push(query.level)
    }
    if (query.resolved === 'true' || query.resolved === '1') conditions.push('e.resolved_at IS NOT NULL')
    if (query.resolved === 'false' || query.resolved === '0') conditions.push('e.resolved_at IS NULL')
    if (query.request_id) {
      conditions.push('e.request_id = ?')
      values.push(query.request_id)
    }
    dateFilters(query, conditions, values, 'e')
    const where = conditions.join(' AND ')
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT e.id, e.user_id, u.name AS user_name, e.request_id, e.level, e.category,
              e.message, e.error_code, e.path, e.method, e.created_at,
              e.resolved_at, e.resolved_by, resolver.name AS resolved_by_name,
              e.resolution_notes
       FROM error_logs e
       LEFT JOIN users u ON u.id = e.user_id
       LEFT JOIN users resolver ON resolver.id = e.resolved_by
       WHERE ${where}
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT ? OFFSET ?`,
      [...values, limit, offset],
    )
    const [count] = await db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM error_logs e WHERE ${where}`,
      values,
    )
    return { rows, total: Number(count[0]?.total ?? 0), page, limit }
  }

  async errorFind(id: number, companyId: number, connection: QueryExecutor = db) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT e.*, u.name AS user_name, resolver.name AS resolved_by_name
       FROM error_logs e
       LEFT JOIN users u ON u.id = e.user_id
       LEFT JOIN users resolver ON resolver.id = e.resolved_by
       WHERE e.id = ? AND e.company_id = ? LIMIT 1`,
      [id, companyId],
    )
    return rows[0] ?? null
  }

  async resolve(
    id: number,
    companyId: number,
    userId: number,
    notes: string,
    connection: QueryExecutor,
  ) {
    await connection.execute(
      `UPDATE error_logs
       SET resolved_at = NOW(), resolved_by = ?, resolution_notes = ?
       WHERE id = ? AND company_id = ? AND resolved_at IS NULL`,
      [userId, notes, id, companyId],
    )
    return this.errorFind(id, companyId, connection)
  }
}
