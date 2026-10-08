import { assertAccountingDate } from './AccountingDatePolicy'
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
  private async setting(connection: QueryExecutor, companyId: number, key: string) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT setting_value FROM settings WHERE company_id=? AND setting_key=? LIMIT 1',
      [companyId, key],
    )
    return rows[0]?.setting_value
  }

  async ensureCustomerCreditLimit(
    connection: QueryExecutor,
    companyId: number,
    customerId: number,
    invoiceId: number,
    newBaseAmount: number,
  ) {
    if (!booleanSettingEnabled(await this.setting(connection, companyId, 'sales.block_over_credit_limit'))) return
    const [customers] = await connection.execute<RowDataPacket[]>(
      'SELECT credit_limit FROM customers WHERE id=? AND company_id=? LIMIT 1 FOR SHARE',
      [customerId, companyId],
    )
    const limit = Number(customers[0]?.credit_limit ?? 0)
    if (limit <= 0) return
    const [balances] = await connection.execute<RowDataPacket[]>(
      `SELECT COALESCE(SUM(GREATEST(base_grand_total-(paid_amount*exchange_rate),0)),0) outstanding
         FROM sales_invoices
        WHERE company_id=? AND customer_id=? AND id<>?
          AND status IN('pending_approval','approved','posted','partially_paid')`,
      [companyId, customerId, invoiceId],
    )
    const exposure = Number(balances[0]?.outstanding ?? 0) + newBaseAmount
    if (exposure > limit)
      throw new ConflictError(`Limit kredit pelanggan terlampaui. Eksposur Rp ${Math.round(exposure).toLocaleString('id-ID')} dari batas Rp ${Math.round(limit).toLocaleString('id-ID')}`)
  }

  async ensurePurchaseOrderPolicy(
    connection: QueryExecutor,
    companyId: number,
    purchaseOrderId: number | null,
    goodsReceiptId: number | null,
  ) {
    if (!booleanSettingEnabled(await this.setting(connection, companyId, 'purchases.require_purchase_order'))) return
    if (!purchaseOrderId && !goodsReceiptId)
      throw new ConflictError('Kebijakan perusahaan mewajibkan Purchase Order sebelum invoice pembelian diajukan')
  }

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
    await connection.execute('SELECT id FROM companies WHERE id=? LOCK IN SHARE MODE',[companyId])
    const [policies]=await connection.execute<RowDataPacket[]>("SELECT setting_key,setting_value FROM settings WHERE company_id=? AND setting_key IN ('accounting.transaction_lock_date','accounting.max_backdate_days','accounting.allow_future_dates','accounting.posting_timezone') LOCK IN SHARE MODE",[companyId])
    const policy=Object.fromEntries(policies.map(p=>[p.setting_key,p.setting_value]))
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:String(policy['accounting.posting_timezone']??'Asia/Jakarta'),year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())
    assertAccountingDate(value.slice(0,10),today,policy)
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
