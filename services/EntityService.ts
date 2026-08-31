import type { RowDataPacket } from 'mysql2'
import { db, transaction } from '../config/database'
import { EntityRepository, type EntityTable } from '../repositories/EntityRepository'
import type { DatabaseValue, QueryExecutor } from '../types/database'
import { ConflictError, NotFoundError } from '../utils/AppError'
import { AuditService } from './AuditService'
import { BusinessValidationService } from './BusinessValidationService'

export interface MutationContext {
  userId: number
  requestId?: string
  ip?: string
}

type ListQuery = {
  page?: string
  limit?: string
  search?: string
  sort?: string
  order?: string
  is_active?: string
  status?: string
}

const referenceRules: Partial<
  Record<EntityTable, Array<{ field: string; table: string; label: string; postingOnly?: boolean }>>
> = {
  accounts: [{ field: 'parent_id', table: 'accounts', label: 'Akun induk' }],
  customers: [
    {
      field: 'receivable_account_id',
      table: 'accounts',
      label: 'Akun piutang',
      postingOnly: true,
    },
  ],
  suppliers: [
    {
      field: 'payable_account_id',
      table: 'accounts',
      label: 'Akun utang',
      postingOnly: true,
    },
  ],
  items: [
    { field: 'unit_id', table: 'units', label: 'Satuan' },
    { field: 'sales_account_id', table: 'accounts', label: 'Akun penjualan', postingOnly: true },
    {
      field: 'inventory_account_id',
      table: 'accounts',
      label: 'Akun persediaan',
      postingOnly: true,
    },
    { field: 'cogs_account_id', table: 'accounts', label: 'Akun HPP', postingOnly: true },
    {
      field: 'purchase_account_id',
      table: 'accounts',
      label: 'Akun pembelian',
      postingOnly: true,
    },
  ],
  tax_codes: [
    {
      field: 'input_tax_account_id',
      table: 'accounts',
      label: 'Akun pajak masukan',
      postingOnly: true,
    },
    {
      field: 'output_tax_account_id',
      table: 'accounts',
      label: 'Akun pajak keluaran',
      postingOnly: true,
    },
  ],
  projects: [{ field: 'customer_id', table: 'customers', label: 'Pelanggan' }],
  bank_accounts: [
    { field: 'gl_account_id', table: 'accounts', label: 'Akun GL bank', postingOnly: true },
  ],
}

function normalizeData(table: EntityTable, data: Record<string, unknown>, context: MutationContext) {
  const normalized = { ...data }
  if (table === 'accounts' && normalized.is_header === true) normalized.is_posting = false
  if (table === 'bank_accounts') {
    normalized.created_by ??= context.userId
    if (normalized.opening_balance !== undefined && normalized.current_balance === undefined)
      normalized.current_balance = normalized.opening_balance
  }
  return normalized
}

export class EntityService {
  private readonly repo: EntityRepository

  constructor(
    private readonly table: EntityTable,
    private readonly audit = new AuditService(),
    private readonly validation = new BusinessValidationService(),
  ) {
    this.repo = new EntityRepository(table)
  }

  list(companyId: number, query: ListQuery) {
    return this.repo.list(companyId, query)
  }

  async get(id: number, companyId: number, connection: QueryExecutor = db) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new NotFoundError()
    const row = await this.repo.find(id, companyId, connection)
    if (!row) throw new NotFoundError()
    return row
  }

  async create(companyId: number, data: Record<string, unknown>, context: MutationContext) {
    return transaction(async (connection) => {
      const normalized = normalizeData(this.table, data, context)
      await this.validateReferences(connection, companyId, normalized)
      await this.validatePeriod(connection, companyId, normalized)
      const row = await this.repo.create(companyId, normalized, connection)
      await this.audit.log(connection, {
        companyId,
        userId: context.userId,
        module: this.table,
        action: 'create',
        recordType: this.table,
        recordId: Number(row?.id),
        newValue: row,
        requestId: context.requestId,
        ip: context.ip,
      })
      return row
    })
  }

  async update(
    id: number,
    companyId: number,
    data: Record<string, unknown>,
    context: MutationContext,
  ) {
    return transaction(async (connection) => {
      const existing = await this.get(id, companyId, connection)
      if (
        this.table === 'accounting_periods' &&
        data.status !== undefined &&
        data.status !== existing.status
      )
        throw new ConflictError('Gunakan aksi tutup atau buka kembali untuk mengubah status periode')

      const normalized = normalizeData(this.table, data, context)
      delete normalized.created_by
      delete normalized.current_balance
      await this.validateReferences(connection, companyId, normalized, id)
      await this.validatePeriod(connection, companyId, { ...existing, ...normalized }, id)
      const row = await this.repo.update(id, companyId, normalized, connection)
      await this.audit.log(connection, {
        companyId,
        userId: context.userId,
        module: this.table,
        action: 'update',
        recordType: this.table,
        recordId: id,
        oldValue: existing,
        newValue: row,
        requestId: context.requestId,
        ip: context.ip,
      })
      return row
    })
  }

  async remove(id: number, companyId: number, context: MutationContext) {
    return transaction(async (connection) => {
      const existing = await this.get(id, companyId, connection)
      const inUse = await this.repo.isInUse(id, companyId, connection)
      const result = await this.repo.remove(id, companyId, inUse, connection)
      if (result === 'blocked') throw new ConflictError('Data sudah digunakan dan tidak dapat dihapus')
      await this.audit.log(connection, {
        companyId,
        userId: context.userId,
        module: this.table,
        action: result,
        recordType: this.table,
        recordId: id,
        oldValue: existing,
        requestId: context.requestId,
        ip: context.ip,
      })
      return result
    })
  }

  private async validateReferences(
    connection: QueryExecutor,
    companyId: number,
    data: Record<string, unknown>,
    currentId?: number,
  ) {
    for (const rule of referenceRules[this.table] ?? []) {
      const id = data[rule.field]
      if (id === undefined || id === null) continue
      if (this.table === 'accounts' && rule.field === 'parent_id') {
        if (Number(id) === currentId) throw new ConflictError('Akun tidak dapat menjadi induknya sendiri')
        if (
          currentId &&
          (await this.repo.hasAccountCycle(currentId, Number(id), companyId, connection))
        )
          throw new ConflictError('Hierarki akun akan membentuk siklus')
      }
      await this.validation.ensureActiveReference(connection, {
        table: rule.table,
        id: Number(id),
        companyId,
        label: rule.label,
        postingOnly: rule.postingOnly,
      })
    }
  }

  private async validatePeriod(
    connection: QueryExecutor,
    companyId: number,
    data: Record<string, unknown>,
    currentId?: number,
  ) {
    if (this.table !== 'accounting_periods') return
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT id
       FROM accounting_periods
       WHERE company_id = ? AND id <> ?
         AND start_date <= ? AND end_date >= ?
       LIMIT 1`,
      [companyId, currentId ?? 0, data.end_date, data.start_date] as DatabaseValue[],
    )
    if (rows[0]) throw new ConflictError('Rentang periode tumpang tindih dengan periode lain')
  }
}
