import { reportGroups } from '../constants/coa-report-groups'
import { assertGovernedChange } from './CoaControlService'
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
  approvedCoaChange?: boolean
}

type ListQuery = {
  page?: string
  limit?: string
  search?: string
  sort?: string
  order?: string
  is_active?: string
  status?: string
  account_type?: string
  is_posting?: string
  is_header?: string
  item_type?: string
  tax_type?: string
}

const referenceRules: Partial<
  Record<
    EntityTable,
    Array<{
      field: string
      table: string
      label: string
      postingOnly?: boolean
      headerOnly?: boolean
    }>
  >
> = {
  accounts: [
    {
      field: 'parent_id',
      table: 'accounts',
      label: 'Akun induk',
      headerOnly: true,
    },
  ],
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
    { field: 'smallest_unit_id', table: 'units', label: 'Satuan terkecil' },
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

function normalizeData(
  table: EntityTable,
  data: Record<string, unknown>,
  context: MutationContext,
) {
  const normalized = { ...data }
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
    return transaction((connection) =>
      this.createInTransaction(connection, companyId, data, context),
    )
  }

  async createInTransaction(
    connection: QueryExecutor,
    companyId: number,
    data: Record<string, unknown>,
    context: MutationContext,
  ) {
    if (this.table === 'accounts') await connection.execute('SELECT id FROM companies WHERE id=? FOR UPDATE',[companyId])
    let normalized = normalizeData(this.table, data, context)
    if (this.table === 'accounts')
      normalized = await this.prepareAccountData(connection, companyId, normalized)
    await this.validateReferences(connection, companyId, normalized)
    await this.validatePeriod(connection, companyId, normalized)
    const row = await this.repo.create(companyId, normalized, connection)
    if (this.table === 'items' && row?.id && row?.unit_id)
      await connection.execute(
        `INSERT INTO item_units(company_id,item_id,unit_id,factor_to_stock,is_purchase,is_sales,is_active)
         VALUES(?,?,?,1,TRUE,TRUE,TRUE) ON DUPLICATE KEY UPDATE factor_to_stock=1,is_active=TRUE`,
        [companyId, Number(row.id), Number(row.unit_id)],
      )
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
  }

  async update(
    id: number,
    companyId: number,
    data: Record<string, unknown>,
    context: MutationContext,
  ) {
    return transaction(connection => this.updateInTransaction(connection,id,companyId,data,context))
  }

  async updateInTransaction(connection: QueryExecutor, id: number, companyId: number, data: Record<string,unknown>, context: MutationContext) {
      if (this.table === 'accounts') await assertGovernedChange(connection,companyId,context.approvedCoaChange)
      const existing = await this.get(id, companyId, connection)
      if (
        this.table === 'items' &&
        data.unit_id !== undefined &&
        Number(data.unit_id) !== Number(existing.unit_id) &&
        (await this.repo.isInUse(id, companyId, connection))
      )
        throw new ConflictError(
          'Satuan stok barang yang sudah dipakai transaksi tidak dapat diubah. Gunakan satuan terkecil dan faktor konversi untuk pelaporan.',
        )
      if (
        this.table === 'accounting_periods' &&
        data.status !== undefined &&
        data.status !== existing.status
      )
        throw new ConflictError(
          'Gunakan aksi tutup atau buka kembali untuk mengubah status periode',
        )

      let normalized = normalizeData(this.table, data, context)
      delete normalized.created_by
      delete normalized.current_balance
      if (this.table === 'accounts')
        normalized = await this.prepareAccountData(connection, companyId, normalized, existing)
      await this.validateReferences(connection, companyId, normalized, id)
      await this.validatePeriod(connection, companyId, { ...existing, ...normalized }, id)
      const row = await this.repo.update(id, companyId, normalized, connection)
      if (this.table === 'departments' && normalized.name !== undefined)
        await connection.execute('UPDATE payroll_employees SET department=? WHERE company_id=? AND department_id=?',[String(normalized.name),companyId,id])
      if (this.table === 'accounts')
        await this.repo.syncAccountDescendantLevels(id, companyId, connection)
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
  }

  async remove(id: number, companyId: number, context: MutationContext) {
    return transaction(async (connection) => {
      if (this.table === 'accounts') await assertGovernedChange(connection,companyId,context.approvedCoaChange)
      const existing = await this.get(id, companyId, connection)
      if (
        this.table === 'accounts' &&
        (await this.repo.accountHasChildren(id, companyId, connection))
      )
        throw new ConflictError('Akun induk yang masih memiliki akun anak tidak dapat dihapus')
      const inUse = await this.repo.isInUse(id, companyId, connection)
      const result = await this.repo.remove(id, companyId, inUse, connection)
      if (result === 'blocked')
        throw new ConflictError('Data sudah digunakan dan tidak dapat dihapus')
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
        if (Number(id) === currentId)
          throw new ConflictError('Akun tidak dapat menjadi induknya sendiri')
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
        headerOnly: rule.headerOnly,
      })
    }
  }

  private async prepareAccountData(
    connection: QueryExecutor,
    companyId: number,
    data: Record<string, unknown>,
    existing?: RowDataPacket,
  ) {
    const target = { ...(existing ?? {}), ...data }
    delete data.level
    if(!existing&&data.presentation_order==null){const numeric=Number(data.code);data.presentation_order=/^[1-8][0-9]{5}$/.test(String(data.code))?numeric:({asset:190000,liability:290000,equity:390000,revenue:490000,cogs:590000,expense:690000,other_income:790000,other_expense:890000} as Record<string,number>)[String(target.account_type)]??990000}
    if (data.report_group && (!existing || data.report_group !== existing.report_group)) {
      const group=reportGroups.find(g=>g.key===data.report_group)
      if(!group || group.type!==String(target.account_type)) throw new ConflictError('Kelompok laporan tidak sesuai tipe akun. Pilih kelompok baku pada Kendali COA.')
    }

    if (data.is_header === true) {
      target.is_header = true
      target.is_posting = false
    } else if (data.is_posting === true) {
      target.is_header = false
      target.is_posting = true
    }
    const isHeader = Boolean(target.is_header)
    const isPosting = Boolean(target.is_posting)
    if (isHeader === isPosting)
      throw new ConflictError('Pilih tepat satu fungsi akun: akun header atau akun posting')

    if (isHeader) {
      data.is_posting = false
      data.allow_manual_journal = false
    } else {
      data.is_header = false
    }

    const parentId = target.parent_id === null || target.parent_id === undefined
      ? null
      : Number(target.parent_id)
    let level = 0
    if (parentId !== null) {
      const parent = await this.repo.find(parentId, companyId, connection)
      if (!parent || parent.deleted_at || !parent.is_active || !parent.is_header)
        throw new ConflictError('Akun induk harus berupa akun header yang aktif')
      if (String(parent.account_type) !== String(target.account_type))
        throw new ConflictError('Tipe akun anak harus sama dengan tipe akun induk')
      level = Number(parent.level) + 1
    }
    if (level > 10) throw new ConflictError('Hierarki akun maksimum 10 level')
    data.level = level

    if (existing) {
      const id = Number(existing.id)
      const hasChildren = await this.repo.accountHasChildren(id, companyId, connection)
      if (!isHeader && hasChildren)
        throw new ConflictError('Akun yang memiliki akun anak harus tetap menjadi akun header')
      if (!Boolean(target.is_active) && hasChildren)
        throw new ConflictError('Pindahkan atau nonaktifkan akun anak sebelum menonaktifkan akun induk')
      if (hasChildren && String(target.account_type) !== String(existing.account_type))
        throw new ConflictError('Tipe akun induk yang memiliki akun anak tidak dapat diubah')
      if (await this.repo.accountHasJournalEntries(id, companyId, connection)) {
        if (String(target.account_type) !== String(existing.account_type))
          throw new ConflictError('Tipe akun yang sudah memiliki jurnal tidak dapat diubah')
        if (String(target.normal_balance) !== String(existing.normal_balance))
          throw new ConflictError('Saldo normal akun yang sudah memiliki jurnal tidak dapat diubah')
        if (!isPosting)
          throw new ConflictError('Akun yang sudah memiliki jurnal harus tetap menjadi akun posting')
      }
    }
    return data
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
