import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import { db } from '../config/database'
import type { DatabaseValue, QueryExecutor } from '../types/database'
import { pagination } from '../utils/pagination'

interface IdRow extends RowDataPacket {
  id: number
}

export interface RoleDetail extends RowDataPacket {
  id: number
  company_id: number | null
  name: string
  slug: string
  description: string | null
  is_system: boolean
  is_active: boolean
  permissions: RowDataPacket[]
}

export class RoleRepository {
  async list(companyId: number, query: { page?: string; limit?: string; search?: string }) {
    const { page, limit, offset } = pagination(query.page, query.limit)
    const search = `%${query.search?.trim() ?? ''}%`
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT r.id, r.company_id, r.name, r.slug, r.description, r.is_system, r.is_active,
              r.created_at, r.updated_at, COUNT(DISTINCT rp.permission_id) AS permission_count,
              COUNT(DISTINCT ur.user_id) AS user_count
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN user_roles ur ON ur.role_id = r.id
       WHERE (r.company_id IS NULL OR r.company_id = ?)
         AND CONCAT(r.name, ' ', r.slug) LIKE ?
       GROUP BY r.id
       ORDER BY r.is_system DESC, r.name ASC
       LIMIT ? OFFSET ?`,
      [companyId, search, limit, offset],
    )
    const [count] = await db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total
       FROM roles
       WHERE (company_id IS NULL OR company_id = ?) AND CONCAT(name, ' ', slug) LIKE ?`,
      [companyId, search],
    )
    return { rows, total: Number(count[0]?.total ?? 0), page, limit }
  }

  async find(id: number, companyId: number, connection: QueryExecutor = db) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT id, company_id, name, slug, description, is_system, is_active, created_at, updated_at
       FROM roles
       WHERE id = ? AND (company_id IS NULL OR company_id = ?)
       LIMIT 1`,
      [id, companyId],
    )
    if (!rows[0]) return null
    const [permissions] = await connection.execute<RowDataPacket[]>(
      `SELECT p.id, p.module, p.action, p.name, p.slug
       FROM permissions p
       INNER JOIN role_permissions rp ON rp.permission_id = p.id
       WHERE rp.role_id = ?
       ORDER BY p.module, p.action`,
      [id],
    )
    return Object.assign(rows[0], { permissions }) as RoleDetail
  }

  async create(
    companyId: number,
    data: { name: string; slug: string; description?: string | null; is_active: boolean },
    connection: QueryExecutor,
  ) {
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO roles (company_id, name, slug, description, is_system, is_active)
       VALUES (?, ?, ?, ?, FALSE, ?)`,
      [companyId, data.name, data.slug, data.description ?? null, data.is_active],
    )
    return result.insertId
  }

  async update(
    id: number,
    companyId: number,
    data: Record<string, unknown>,
    connection: QueryExecutor,
  ) {
    const entries = Object.entries(data).filter(([, value]) => value !== undefined)
    if (entries.length === 0) return
    await connection.execute(
      `UPDATE roles
       SET ${entries.map(([key]) => `${key} = ?`).join(', ')}
       WHERE id = ? AND company_id = ? AND is_system = FALSE`,
      [...entries.map(([, value]) => value), id, companyId] as DatabaseValue[],
    )
  }

  async validatePermissions(permissionIds: number[], connection: QueryExecutor) {
    if (permissionIds.length === 0) return []
    const placeholders = permissionIds.map(() => '?').join(', ')
    const [rows] = await connection.execute<IdRow[]>(
      `SELECT id FROM permissions WHERE id IN (${placeholders})`,
      permissionIds,
    )
    return rows.map((row) => Number(row.id))
  }

  async assignPermissions(roleId: number, permissionIds: number[], connection: QueryExecutor) {
    await connection.execute('DELETE FROM role_permissions WHERE role_id = ?', [roleId])
    for (const permissionId of permissionIds)
      await connection.execute(
        'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
        [roleId, permissionId],
      )
  }

  async deactivate(id: number, companyId: number, connection: QueryExecutor) {
    await connection.execute(
      `UPDATE roles SET is_active = FALSE
       WHERE id = ? AND company_id = ? AND is_system = FALSE`,
      [id, companyId],
    )
  }

  async permissionList(query: { page?: string; limit?: string; search?: string; module?: string }) {
    const { page, limit, offset } = pagination(query.page, query.limit)
    const conditions = ["CONCAT(module, ' ', action, ' ', name, ' ', slug) LIKE ?"]
    const values: DatabaseValue[] = [`%${query.search?.trim() ?? ''}%`]
    if (query.module) {
      conditions.push('module = ?')
      values.push(query.module)
    }
    const where = conditions.join(' AND ')
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT id, module, action, name, slug, created_at
       FROM permissions WHERE ${where}
       ORDER BY module, action LIMIT ? OFFSET ?`,
      [...values, limit, offset],
    )
    const [count] = await db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM permissions WHERE ${where}`,
      values,
    )
    return { rows, total: Number(count[0]?.total ?? 0), page, limit }
  }

  async findPermission(id: number, connection: QueryExecutor = db) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT id, module, action, name, slug, created_at
       FROM permissions WHERE id = ? LIMIT 1`,
      [id],
    )
    return rows[0] ?? null
  }

  async createPermission(
    data: { module: string; action: string; name: string },
    connection: QueryExecutor,
  ) {
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO permissions (module, action, name, slug) VALUES (?, ?, ?, ?)`,
      [data.module, data.action, data.name, `${data.module}.${data.action}`],
    )
    return result.insertId
  }

  async updatePermission(
    id: number,
    data: { module: string; action: string; name: string },
    connection: QueryExecutor,
  ) {
    await connection.execute(
      `UPDATE permissions SET module = ?, action = ?, name = ?, slug = ? WHERE id = ?`,
      [data.module, data.action, data.name, `${data.module}.${data.action}`, id],
    )
  }

  async permissionInUse(id: number, connection: QueryExecutor) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT 1 FROM role_permissions WHERE permission_id = ? LIMIT 1',
      [id],
    )
    return Boolean(rows[0])
  }

  async deletePermission(id: number, connection: QueryExecutor) {
    await connection.execute('DELETE FROM permissions WHERE id = ?', [id])
  }
}
