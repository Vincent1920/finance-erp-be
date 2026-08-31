import type { RowDataPacket } from 'mysql2'
import type { QueryExecutor } from '../types/database'
import { ConflictError, NotFoundError } from '../utils/AppError'

const allowedReferenceTables = new Set([
  'accounts',
  'customers',
  'suppliers',
  'items',
  'warehouses',
  'units',
  'tax_codes',
  'cost_centers',
  'projects',
  'bank_accounts',
])

export interface ReferenceCheck {
  table: string
  id: number
  companyId: number
  label: string
  postingOnly?: boolean
}

export class BusinessValidationService {
  async ensureOpenPeriod(connection: QueryExecutor, companyId: number, date: Date | string) {
    const value = date instanceof Date ? date.toISOString().slice(0, 10) : date
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT id, year, month, start_date, end_date, status
       FROM accounting_periods
       WHERE company_id = ? AND ? BETWEEN start_date AND end_date
       LIMIT 1`,
      [companyId, value],
    )
    const period = rows[0]
    if (!period) throw new ConflictError('Periode akuntansi untuk tanggal tersebut belum dibuat')
    if (period.status !== 'open') throw new ConflictError('Periode akuntansi tidak terbuka')
    return period
  }

  async ensureActiveReference(connection: QueryExecutor, input: ReferenceCheck) {
    if (!allowedReferenceTables.has(input.table)) throw new Error('Reference table tidak diizinkan')
    const active = input.table === 'projects' ? "status <> 'inactive'" : 'is_active = TRUE'
    const posting = input.postingOnly && input.table === 'accounts' ? 'AND is_posting = TRUE' : ''
    const deleted = ['accounts', 'customers', 'suppliers', 'items', 'bank_accounts'].includes(
      input.table,
    )
      ? 'AND deleted_at IS NULL'
      : ''
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT id
       FROM ${input.table}
       WHERE id = ? AND company_id = ? AND ${active} ${posting} ${deleted}
       LIMIT 1`,
      [input.id, input.companyId],
    )
    if (!rows[0]) throw new NotFoundError(`${input.label} tidak ditemukan atau tidak aktif`)
  }
}
