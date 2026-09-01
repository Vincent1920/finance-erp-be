import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import { db } from '../config/database'
import type { DatabaseValue, QueryExecutor } from '../types/database'
import { pagination } from '../utils/pagination'

interface IdRow extends RowDataPacket {
  id: number
}

export class SystemUserRepository {
  async list(
    companyId: number,
    query: { page?: string; limit?: string; search?: string; status?: string },
  ) {
    const { page, limit, offset } = pagination(query.page, query.limit)
    const conditions = [
      'u.company_id = ?',
      'u.deleted_at IS NULL',
      "CONCAT(u.name, ' ', u.email) LIKE ?",
    ]
    const values: DatabaseValue[] = [companyId, `%${query.search?.trim() ?? ''}%`]
    if (query.status && ['active', 'inactive', 'locked'].includes(query.status)) {
      conditions.push('u.status = ?')
      values.push(query.status)
    }
    const where = conditions.join(' AND ')
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT u.id, u.company_id, u.name, u.email, u.status, u.last_login_at,
              u.locked_at, u.password_changed_at, u.created_at, u.updated_at,
              COALESCE(GROUP_CONCAT(DISTINCT r.slug ORDER BY r.slug SEPARATOR ','), '') AS role_slugs
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
       WHERE ${where}
       GROUP BY u.id
       ORDER BY u.name ASC, u.id ASC
       LIMIT ? OFFSET ?`,
      [...values, limit, offset],
    )
    const [count] = await db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM users u WHERE ${where}`,
      values,
    )
    return {
      rows: rows.map(({ role_slugs, ...row }) => ({
        ...row,
        roles: role_slugs ? String(role_slugs).split(',') : [],
      })),
      total: Number(count[0]?.total ?? 0),
      page,
      limit,
    }
  }

  async find(id: number, companyId: number, connection: QueryExecutor = db) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT u.id, u.company_id, u.name, u.email, u.status, u.last_login_at,
              u.locked_at, u.locked_by, u.password_changed_at,
              u.failed_login_attempts, u.last_failed_login_at,
              u.created_at, u.updated_at, u.updated_by
       FROM users u
       WHERE u.id = ? AND u.company_id = ? AND u.deleted_at IS NULL
       LIMIT 1`,
      [id, companyId],
    )
    if (!rows[0]) return null
    const [roles] = await connection.execute<RowDataPacket[]>(
      `SELECT r.id, r.name, r.slug
       FROM roles r
       INNER JOIN user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = ?
       ORDER BY r.name`,
      [id],
    )
    return { ...rows[0], roles }
  }

  async create(
    companyId: number,
    data: { name: string; email: string; password: string; status: string },
    actorId: number,
    connection: QueryExecutor,
  ) {
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO users (
         company_id, name, email, password, status, password_changed_at, updated_by
       ) VALUES (?, ?, ?, ?, ?, NOW(), ?)`,
      [companyId, data.name, data.email, data.password, data.status, actorId],
    )
    return result.insertId
  }

  async update(
    id: number,
    companyId: number,
    data: { name?: string; email?: string },
    actorId: number,
    connection: QueryExecutor,
  ) {
    const entries = Object.entries(data).filter(([, value]) => value !== undefined)
    if (entries.length === 0) return
    await connection.execute(
      `UPDATE users
       SET ${entries.map(([key]) => `${key} = ?`).join(', ')}, updated_by = ?
       WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      [...entries.map(([, value]) => value), actorId, id, companyId] as DatabaseValue[],
    )
  }

  async setStatus(
    id: number,
    companyId: number,
    status: 'active' | 'inactive' | 'locked',
    actorId: number,
    connection: QueryExecutor,
  ) {
    await connection.execute(
      `UPDATE users
       SET status = ?,
           locked_at = IF(? = 'locked', NOW(), NULL),
           locked_by = IF(? = 'locked', ?, NULL),
           failed_login_attempts = IF(? = 'active', 0, failed_login_attempts),
           updated_by = ?
       WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      [status, status, status, actorId, status, actorId, id, companyId],
    )
  }

  async resetPassword(
    id: number,
    companyId: number,
    passwordHash: string,
    actorId: number,
    connection: QueryExecutor,
  ) {
    await connection.execute(
      `UPDATE users
       SET password = ?, password_changed_at = NOW(), failed_login_attempts = 0,
           last_failed_login_at = NULL,
           status = IF(status = 'locked', 'active', status),
           locked_at = NULL, locked_by = NULL, updated_by = ?
       WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      [passwordHash, actorId, id, companyId],
    )
  }

  async validateRoles(
    roleIds: number[],
    companyId: number,
    allowSuperAdmin: boolean,
    connection: QueryExecutor,
  ) {
    if (roleIds.length === 0) return []
    const placeholders = roleIds.map(() => '?').join(', ')
    const [rows] = await connection.execute<IdRow[]>(
      `SELECT id
       FROM roles
       WHERE id IN (${placeholders}) AND is_active = TRUE
         AND (company_id IS NULL OR company_id = ?)
         AND (? = TRUE OR slug <> 'super-admin')`,
      [...roleIds, companyId, allowSuperAdmin],
    )
    return rows.map((row) => Number(row.id))
  }

  async assignRoles(userId: number, roleIds: number[], connection: QueryExecutor) {
    await connection.execute('DELETE FROM user_roles WHERE user_id = ?', [userId])
    for (const roleId of roleIds)
      await connection.execute('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [
        userId,
        roleId,
      ])
  }

  async softDelete(id: number, companyId: number, actorId: number, connection: QueryExecutor) {
    await connection.execute(
      `UPDATE users
       SET status = 'inactive', deleted_at = NOW(), updated_by = ?
       WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      [actorId, id, companyId],
    )
  }
}
