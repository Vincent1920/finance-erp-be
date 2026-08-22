import { db } from '../config/database'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import { pagination } from '../utils/pagination'
const allowed = [
  'accounts',
  'customers',
  'suppliers',
  'items',
  'warehouses',
  'units',
  'tax_codes',
  'cost_centers',
  'projects',
] as const
export type EntityTable = (typeof allowed)[number]
type DbValue = string | number | boolean | null
export class EntityRepository {
  constructor(private table: EntityTable) {}
  async list(companyId: number, query: { page?: string; limit?: string; search?: string }) {
    const { page, limit, offset } = pagination(query.page, query.limit),
      search = `%${query.search ?? ''}%`,
      nameColumn =
        this.table === 'items'
          ? 'CONCAT(sku," ",name)'
          : this.table === 'accounts'
            ? 'CONCAT(code," ",name)'
            : 'name'
    const soft = ['accounts', 'customers', 'suppliers', 'items'].includes(this.table)
      ? 'AND deleted_at IS NULL'
      : ''
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT * FROM ${this.table} WHERE company_id=? AND ${nameColumn} LIKE ? ${soft} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [companyId, search, limit, offset],
    )
    const [count] = await db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) total FROM ${this.table} WHERE company_id=? AND ${nameColumn} LIKE ? ${soft}`,
      [companyId, search],
    )
    return { rows, total: Number(count[0]?.total ?? 0), page, limit }
  }
  async find(id: number, companyId: number) {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT * FROM ${this.table} WHERE id=? AND company_id=? LIMIT 1`,
      [id, companyId],
    )
    return rows[0] ?? null
  }
  async create(companyId: number, data: Record<string, unknown>) {
    const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined))
    const columns = ['company_id', ...Object.keys(clean)],
      values = [companyId, ...Object.values(clean)] as DbValue[],
      marks = columns.map(() => '?').join(',')
    const [result] = await db.execute<ResultSetHeader>(
      `INSERT INTO ${this.table} (${columns.join(',')}) VALUES (${marks})`,
      values,
    )
    return this.find(result.insertId, companyId)
  }
  async update(id: number, companyId: number, data: Record<string, unknown>) {
    const entries = Object.entries(data).filter(([, v]) => v !== undefined)
    if (entries.length) {
      const values = [...entries.map(([, v]) => v), id, companyId] as DbValue[]
      await db.execute(
        `UPDATE ${this.table} SET ${entries.map(([k]) => `${k}=?`).join(',')} WHERE id=? AND company_id=?`,
        values,
      )
    }
    return this.find(id, companyId)
  }
  async remove(id: number, companyId: number) {
    if (['accounts', 'customers', 'suppliers', 'items'].includes(this.table))
      await db.execute(
        `UPDATE ${this.table} SET deleted_at=NOW(),is_active=FALSE WHERE id=? AND company_id=?`,
        [id, companyId],
      )
    else await db.execute(`DELETE FROM ${this.table} WHERE id=? AND company_id=?`, [id, companyId])
  }
}
