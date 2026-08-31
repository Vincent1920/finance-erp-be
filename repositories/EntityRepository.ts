import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import { db } from '../config/database'
import type { DatabaseValue, QueryExecutor } from '../types/database'
import { pagination } from '../utils/pagination'

export const entityDefinitions = {
  accounting_periods: {
    search: "CONCAT(year, ' ', LPAD(month, 2, '0'), ' ', status)",
    sort: ['year', 'month', 'start_date', 'end_date', 'status', 'id'],
    defaultSort: 'year',
    activeColumn: null,
    deleted: false,
  },
  accounts: {
    search: "CONCAT(code, ' ', name)",
    sort: ['code', 'name', 'account_type', 'is_active', 'id'],
    defaultSort: 'code',
    activeColumn: 'is_active',
    deleted: true,
  },
  customers: {
    search: "CONCAT(code, ' ', name, ' ', COALESCE(email, ''), ' ', COALESCE(phone, ''))",
    sort: ['code', 'name', 'credit_limit', 'is_active', 'id'],
    defaultSort: 'name',
    activeColumn: 'is_active',
    deleted: true,
  },
  suppliers: {
    search: "CONCAT(code, ' ', name, ' ', COALESCE(email, ''), ' ', COALESCE(phone, ''))",
    sort: ['code', 'name', 'is_active', 'id'],
    defaultSort: 'name',
    activeColumn: 'is_active',
    deleted: true,
  },
  items: {
    search: "CONCAT(sku, ' ', name, ' ', COALESCE(barcode, ''))",
    sort: ['sku', 'name', 'item_type', 'sales_price', 'average_cost', 'is_active', 'id'],
    defaultSort: 'name',
    activeColumn: 'is_active',
    deleted: true,
  },
  warehouses: {
    search: "CONCAT(code, ' ', name)",
    sort: ['code', 'name', 'is_active', 'id'],
    defaultSort: 'name',
    activeColumn: 'is_active',
    deleted: false,
  },
  units: {
    search: "CONCAT(code, ' ', name, ' ', symbol)",
    sort: ['code', 'name', 'symbol', 'is_active', 'id'],
    defaultSort: 'name',
    activeColumn: 'is_active',
    deleted: false,
  },
  tax_codes: {
    search: "CONCAT(code, ' ', name, ' ', tax_type)",
    sort: ['code', 'name', 'tax_type', 'rate', 'is_active', 'id'],
    defaultSort: 'code',
    activeColumn: 'is_active',
    deleted: false,
  },
  cost_centers: {
    search: "CONCAT(code, ' ', name)",
    sort: ['code', 'name', 'is_active', 'id'],
    defaultSort: 'name',
    activeColumn: 'is_active',
    deleted: false,
  },
  projects: {
    search: "CONCAT(code, ' ', name, ' ', COALESCE(status, ''))",
    sort: ['code', 'name', 'start_date', 'end_date', 'status', 'budget', 'id'],
    defaultSort: 'name',
    activeColumn: 'status',
    deleted: false,
  },
  bank_accounts: {
    search:
      "CONCAT(code, ' ', bank_name, ' ', account_number, ' ', account_name, ' ', currency)",
    sort: ['code', 'bank_name', 'account_number', 'currency', 'current_balance', 'is_active', 'id'],
    defaultSort: 'bank_name',
    activeColumn: 'is_active',
    deleted: true,
  },
} as const

export type EntityTable = keyof typeof entityDefinitions
type ListQuery = {
  page?: string
  limit?: string
  search?: string
  sort?: string
  order?: string
  is_active?: string
  status?: string
}

const dependencies: Partial<Record<EntityTable, Array<[string, string]>>> = {
  accounts: [
    ['accounts', 'parent_id'],
    ['customers', 'receivable_account_id'],
    ['suppliers', 'payable_account_id'],
    ['items', 'sales_account_id'],
    ['items', 'inventory_account_id'],
    ['items', 'cogs_account_id'],
    ['items', 'purchase_account_id'],
    ['tax_codes', 'input_tax_account_id'],
    ['tax_codes', 'output_tax_account_id'],
    ['journal_lines', 'account_id'],
    ['bank_accounts', 'gl_account_id'],
  ],
  customers: [
    ['projects', 'customer_id'],
    ['sales_orders', 'customer_id'],
    ['sales_invoices', 'customer_id'],
    ['sales_returns', 'customer_id'],
    ['customer_payments', 'customer_id'],
  ],
  suppliers: [
    ['purchase_orders', 'supplier_id'],
    ['purchase_invoices', 'supplier_id'],
    ['purchase_returns', 'supplier_id'],
    ['supplier_payments', 'supplier_id'],
  ],
  items: [
    ['sales_order_lines', 'item_id'],
    ['sales_invoice_lines', 'item_id'],
    ['sales_return_lines', 'item_id'],
    ['purchase_order_lines', 'item_id'],
    ['purchase_invoice_lines', 'item_id'],
    ['purchase_return_lines', 'item_id'],
    ['inventory_balances', 'item_id'],
    ['inventory_movements', 'item_id'],
  ],
  warehouses: [
    ['inventory_balances', 'warehouse_id'],
    ['inventory_movements', 'warehouse_id'],
    ['sales_orders', 'warehouse_id'],
    ['sales_invoices', 'warehouse_id'],
    ['purchase_orders', 'warehouse_id'],
    ['purchase_invoices', 'warehouse_id'],
    ['stock_transfers', 'source_warehouse_id'],
    ['stock_transfers', 'destination_warehouse_id'],
    ['stock_adjustments', 'warehouse_id'],
  ],
  units: [
    ['items', 'unit_id'],
    ['sales_order_lines', 'unit_id'],
    ['sales_invoice_lines', 'unit_id'],
    ['purchase_order_lines', 'unit_id'],
    ['purchase_invoice_lines', 'unit_id'],
  ],
  tax_codes: [
    ['sales_order_lines', 'tax_code_id'],
    ['sales_invoice_lines', 'tax_code_id'],
    ['purchase_order_lines', 'tax_code_id'],
    ['purchase_invoice_lines', 'tax_code_id'],
  ],
  cost_centers: [
    ['journal_lines', 'cost_center_id'],
    ['budget_lines', 'cost_center_id'],
  ],
  projects: [
    ['journal_lines', 'project_id'],
    ['budget_lines', 'project_id'],
  ],
  bank_accounts: [
    ['customer_payments', 'bank_account_id'],
    ['supplier_payments', 'bank_account_id'],
    ['bank_statements', 'bank_account_id'],
  ],
}

export class EntityRepository {
  private readonly definition

  constructor(private readonly table: EntityTable) {
    this.definition = entityDefinitions[table]
  }

  async list(companyId: number, query: ListQuery) {
    const { page, limit, offset } = pagination(query.page, query.limit)
    const conditions = ['company_id = ?', `${this.definition.search} LIKE ?`]
    const values: DatabaseValue[] = [companyId, `%${query.search?.trim() ?? ''}%`]

    if (this.definition.deleted) conditions.push('deleted_at IS NULL')
    if (query.is_active !== undefined && this.definition.activeColumn === 'is_active') {
      conditions.push('is_active = ?')
      values.push(query.is_active === 'true' || query.is_active === '1')
    }
    if (query.status && (this.table === 'projects' || this.table === 'accounting_periods')) {
      conditions.push('status = ?')
      values.push(query.status)
    }

    const requestedSort = query.sort ?? this.definition.defaultSort
    const sort = (this.definition.sort as readonly string[]).includes(requestedSort)
      ? requestedSort
      : this.definition.defaultSort
    const order = query.order?.toLowerCase() === 'asc' ? 'ASC' : 'DESC'
    const where = conditions.join(' AND ')

    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT *
       FROM ${this.table}
       WHERE ${where}
       ORDER BY ${sort} ${order}, id DESC
       LIMIT ? OFFSET ?`,
      [...values, limit, offset],
    )
    const [count] = await db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total
       FROM ${this.table}
       WHERE ${where}`,
      values,
    )
    return { rows, total: Number(count[0]?.total ?? 0), page, limit }
  }

  async find(id: number, companyId: number, connection: QueryExecutor = db) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT *
       FROM ${this.table}
       WHERE id = ? AND company_id = ?
       LIMIT 1`,
      [id, companyId],
    )
    return rows[0] ?? null
  }

  async create(
    companyId: number,
    data: Record<string, unknown>,
    connection: QueryExecutor = db,
  ) {
    const clean = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined))
    const columns = ['company_id', ...Object.keys(clean)]
    const values = [companyId, ...Object.values(clean)] as DatabaseValue[]
    const marks = columns.map(() => '?').join(', ')
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO ${this.table} (${columns.join(', ')})
       VALUES (${marks})`,
      values,
    )
    return this.find(result.insertId, companyId, connection)
  }

  async update(
    id: number,
    companyId: number,
    data: Record<string, unknown>,
    connection: QueryExecutor = db,
  ) {
    const entries = Object.entries(data).filter(([, value]) => value !== undefined)
    if (entries.length > 0) {
      const values = [...entries.map(([, value]) => value), id, companyId] as DatabaseValue[]
      await connection.execute(
        `UPDATE ${this.table}
         SET ${entries.map(([key]) => `${key} = ?`).join(', ')}
         WHERE id = ? AND company_id = ?`,
        values,
      )
    }
    return this.find(id, companyId, connection)
  }

  async isInUse(id: number, companyId: number, connection: QueryExecutor = db) {
    if (this.table === 'accounting_periods') {
      const period = await this.find(id, companyId, connection)
      if (!period) return false
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT EXISTS(
           SELECT 1 FROM journals
           WHERE company_id = ? AND journal_date BETWEEN ? AND ?
         ) AS used`,
        [companyId, period.start_date, period.end_date],
      )
      return Boolean(rows[0]?.used)
    }

    for (const [table, column] of dependencies[this.table] ?? []) {
      const [columns] = await connection.execute<RowDataPacket[]>(
        `SELECT 1
         FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?
         LIMIT 1`,
        [table, column],
      )
      if (!columns[0]) continue
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`,
        [id],
      )
      if (rows[0]) return true
    }
    return false
  }

  async remove(id: number, companyId: number, inUse: boolean, connection: QueryExecutor = db) {
    if (this.definition.deleted) {
      await connection.execute(
        `UPDATE ${this.table}
         SET deleted_at = NOW(), is_active = FALSE
         WHERE id = ? AND company_id = ?`,
        [id, companyId],
      )
      return 'deleted' as const
    }
    if (inUse && this.definition.activeColumn === 'is_active') {
      await connection.execute(
        `UPDATE ${this.table}
         SET is_active = FALSE
         WHERE id = ? AND company_id = ?`,
        [id, companyId],
      )
      return 'deactivated' as const
    }
    if (inUse && this.table === 'projects') {
      await connection.execute(
        `UPDATE projects SET status = 'inactive' WHERE id = ? AND company_id = ?`,
        [id, companyId],
      )
      return 'deactivated' as const
    }
    if (inUse) return 'blocked' as const

    await connection.execute(`DELETE FROM ${this.table} WHERE id = ? AND company_id = ?`, [
      id,
      companyId,
    ])
    return 'deleted' as const
  }

  async hasAccountCycle(
    id: number,
    parentId: number,
    companyId: number,
    connection: QueryExecutor = db,
  ) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `WITH RECURSIVE descendants AS (
         SELECT id FROM accounts WHERE parent_id = ? AND company_id = ?
         UNION ALL
         SELECT child.id
         FROM accounts child
         INNER JOIN descendants parent ON child.parent_id = parent.id
         WHERE child.company_id = ?
       )
       SELECT 1 FROM descendants WHERE id = ? LIMIT 1`,
      [id, companyId, companyId, parentId],
    )
    return Boolean(rows[0])
  }
}
