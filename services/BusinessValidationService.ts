import type { RowDataPacket } from 'mysql2'
import type { QueryExecutor } from '../types/database'
import { ConflictError, ForbiddenError, NotFoundError } from '../utils/AppError'

export const booleanSettingEnabled = (value: unknown) =>
  ['1', 'true', 'yes', 'on'].includes(
    String(value ?? '')
      .trim()
      .toLowerCase(),
  )

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
  headerOnly?: boolean
}

export class BusinessValidationService {
  async ensureIndependentApprover(
    connection: QueryExecutor,
    companyId: number,
    submittedBy: number | null,
    approverId: number,
  ) {
    if (!submittedBy || submittedBy !== approverId) return

    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT setting_value
       FROM settings
       WHERE company_id = ? AND setting_key = 'accounting.allow_self_approval'
       LIMIT 1`,
      [companyId],
    )
    if (!booleanSettingEnabled(rows[0]?.setting_value)) {
      throw new ForbiddenError('Pembuat/pengaju jurnal tidak boleh menyetujui jurnal yang sama')
    }
  }

  async ensureOpenPeriod(connection: QueryExecutor, companyId: number, date: Date | string) {
    const value = date instanceof Date ? date.toISOString().slice(0, 10) : date
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT id, year, month, start_date, end_date, status
       FROM accounting_periods
       WHERE company_id = ? AND ? BETWEEN start_date AND end_date
       LIMIT 1
       FOR SHARE`,
      [companyId, value],
    )
    const period = rows[0]
    if (!period) throw new ConflictError('Periode akuntansi untuk tanggal tersebut belum dibuat')
    if (period.status !== 'open') throw new ConflictError('Periode akuntansi tidak terbuka')
    return period
  }

  async ensureClosedPeriod(connection: QueryExecutor, companyId: number, date: Date | string) {
    const value = date instanceof Date ? date.toISOString().slice(0, 10) : date
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT id,year,month,start_date,end_date,status
       FROM accounting_periods
       WHERE company_id=? AND ? BETWEEN start_date AND end_date
       LIMIT 1
       FOR SHARE`,
      [companyId, value],
    )
    const period = rows[0]
    if (!period) throw new ConflictError('Periode akuntansi untuk tanggal tersebut belum dibuat')
    if (period.status !== 'closed')
      throw new ConflictError('Jurnal tutup tahun hanya dapat diposting pada periode yang sudah ditutup permanen')
    return period
  }

  async ensureActiveReference(connection: QueryExecutor, input: ReferenceCheck) {
    if (!allowedReferenceTables.has(input.table)) throw new Error('Reference table tidak diizinkan')
    const active = input.table === 'projects' ? "status <> 'inactive'" : 'is_active = TRUE'
    const posting = input.postingOnly && input.table === 'accounts' ? 'AND is_posting = TRUE' : ''
    const header = input.headerOnly && input.table === 'accounts' ? 'AND is_header = TRUE' : ''
    const deleted = ['accounts', 'customers', 'suppliers', 'items', 'bank_accounts'].includes(
      input.table,
    )
      ? 'AND deleted_at IS NULL'
      : ''
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT id
       FROM ${input.table}
       WHERE id = ? AND company_id = ? AND ${active} ${posting} ${header} ${deleted}
       LIMIT 1`,
      [input.id, input.companyId],
    )
    if (!rows[0]) throw new NotFoundError(`${input.label} tidak ditemukan atau tidak aktif`)
  }
}
