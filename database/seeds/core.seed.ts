import type { RowDataPacket } from 'mysql2/promise'

import { hashPassword } from '../../utils/password'
import type { SeedConnection } from './types'

const roles = [
  ['Super Admin', 'super-admin'],
  ['Finance Manager', 'finance-manager'],
  ['Accountant', 'accountant'],
  ['AR Staff', 'ar-staff'],
  ['AP Staff', 'ap-staff'],
  ['Sales', 'sales'],
  ['Purchasing', 'purchasing'],
  ['Inventory', 'inventory'],
  ['Auditor', 'auditor'],
] as const

const modules = [
  'dashboard',
  'global-search',
  'accounts',
  'accounting-periods',
  'customers',
  'suppliers',
  'items',
  'warehouses',
  'units',
  'tax-codes',
  'cost-centers',
  'projects',
  'sales',
  'sales-orders',
  'delivery-orders',
  'sales-invoices',
  'sales-returns',
  'receivables',
  'customer-payments',
  'purchases',
  'purchase-orders',
  'goods-receipts',
  'purchase-invoices',
  'purchase-returns',
  'payables',
  'supplier-payments',
  'inventory',
  'stock-transfers',
  'stock-adjustments',
  'inventory-reports',
  'accounting',
  'journals',
  'recurring-journals',
  'general-ledger',
  'trial-balance',
  'banking',
  'bank-accounts',
  'bank-statements',
  'bank-reconciliations',
  'cash-book',
  'cash-transfers',
  'fixed-assets',
  'depreciation',
  'budgets',
  'budget-vs-actual',
  'approvals',
  'transaction-browser',
  'period-closing',
  'year-end-closing',
  'reports',
  'profit-loss',
  'balance-sheet',
  'cash-flow',
  'ar-aging',
  'ap-aging',
  'subledger-reconciliation',
  'users',
  'roles',
  'audit',
  'audit-logs',
  'error-logs',
  'backups',
  'settings',
  'attachments',
  'opening-balances',
  'document-templates',
  'imports',
  'exports',
] as const

const actions = [
  'view',
  'create',
  'update',
  'delete',
  'submit',
  'approve',
  'reject',
  'post',
  'reverse',
  'print',
  'export',
  'close_period',
  'reopen_period',
  'activate',
  'deactivate',
  'lock',
  'reset_password',
  'confirm',
  'cancel',
  'reconcile',
  'import',
  'restore',
] as const

const financeModules = modules.filter(
  (module) =>
    ![
      'users',
      'roles',
      'error-logs',
      'backups',
      'document-templates',
      'imports',
      'exports',
    ].includes(module),
)

const standardActions = actions.filter(
  (action) =>
    !['close_period', 'reopen_period', 'lock', 'reset_password', 'restore'].includes(action),
)

async function grantPermissions(
  connection: SeedConnection,
  roleSlug: string,
  allowedModules: readonly string[],
  allowedActions: readonly string[],
) {
  for (const module of allowedModules) {
    for (const action of allowedActions) {
      await connection.execute(
        `INSERT IGNORE INTO role_permissions (role_id, permission_id)
         SELECT r.id, p.id
           FROM roles r
           JOIN permissions p ON p.module = ? AND p.action = ?
          WHERE r.slug = ?`,
        [module, action, roleSlug],
      )
    }
  }
}

export async function seedCore(connection: SeedConnection) {
  await connection.execute(
    `INSERT INTO companies (id, name, legal_name, base_currency, fiscal_year_start)
     VALUES (1, 'PT Finora Indonesia', 'PT Finora Indonesia', 'IDR', 1)
     ON DUPLICATE KEY UPDATE id = id`,
  )

  for (const [name, slug] of roles) {
    await connection.execute(
      `INSERT INTO roles (name, slug, is_system)
       VALUES (?, ?, TRUE)
       ON DUPLICATE KEY UPDATE is_system = TRUE`,
      [name, slug],
    )
  }

  for (const module of modules) {
    for (const action of actions) {
      await connection.execute(
        'INSERT IGNORE INTO permissions (module, action, name, slug) VALUES (?, ?, ?, ?)',
        [module, action, `${action} ${module}`, `${module}.${action}`],
      )
    }
  }

  const initialPasswordHash = await hashPassword('password')

  await connection.execute(
    `INSERT INTO users (company_id, name, email, password, status, password_changed_at)
     VALUES (1, 'Super Admin', 'admin@financeerp.local', ?, 'active', CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name), company_id = VALUES(company_id)`,
    [initialPasswordHash],
  )

  const [adminRows] = await connection.execute<(RowDataPacket & { id: number })[]>(
    'SELECT id FROM users WHERE email = ? LIMIT 1',
    ['admin@financeerp.local'],
  )
  const adminId = adminRows[0]?.id
  if (!adminId) {
    throw new Error('Seeder gagal menemukan akun Super Admin')
  }

  await connection.execute(
    `INSERT IGNORE INTO user_roles (user_id, role_id)
     SELECT ?, id FROM roles WHERE slug = 'super-admin'`,
    [adminId],
  )
  await connection.execute(
    `INSERT IGNORE INTO role_permissions (role_id, permission_id)
     SELECT r.id, p.id
     FROM roles r
     CROSS JOIN permissions p
     WHERE r.slug = 'super-admin'`,
  )

  await grantPermissions(connection, 'finance-manager', financeModules, actions)
  await grantPermissions(
    connection,
    'accountant',
    [
      'dashboard',
      'global-search',
      'accounts',
      'accounting-periods',
      'accounting',
      'journals',
      'recurring-journals',
      'general-ledger',
      'trial-balance',
      'banking',
      'bank-accounts',
      'bank-statements',
      'bank-reconciliations',
      'cash-book',
      'cash-transfers',
      'fixed-assets',
      'depreciation',
      'budgets',
      'budget-vs-actual',
      'approvals',
      'transaction-browser',
      'reports',
      'profit-loss',
      'balance-sheet',
      'cash-flow',
      'ar-aging',
      'ap-aging',
      'inventory-reports',
      'subledger-reconciliation',
      'attachments',
      'opening-balances',
      'exports',
    ],
    standardActions,
  )
  await grantPermissions(
    connection,
    'ar-staff',
    [
      'dashboard',
      'global-search',
      'customers',
      'sales',
      'sales-orders',
      'delivery-orders',
      'sales-invoices',
      'sales-returns',
      'receivables',
      'customer-payments',
      'ar-aging',
      'attachments',
      'exports',
    ],
    standardActions,
  )
  await grantPermissions(
    connection,
    'ap-staff',
    [
      'dashboard',
      'global-search',
      'suppliers',
      'purchases',
      'purchase-orders',
      'goods-receipts',
      'purchase-invoices',
      'purchase-returns',
      'payables',
      'supplier-payments',
      'ap-aging',
      'attachments',
      'exports',
    ],
    standardActions,
  )
  await grantPermissions(
    connection,
    'sales',
    [
      'dashboard',
      'global-search',
      'customers',
      'items',
      'sales',
      'sales-orders',
      'delivery-orders',
      'sales-invoices',
      'receivables',
      'attachments',
      'exports',
    ],
    ['view', 'create', 'update', 'delete', 'submit', 'confirm', 'cancel', 'print', 'export'],
  )
  await grantPermissions(
    connection,
    'purchasing',
    [
      'dashboard',
      'global-search',
      'suppliers',
      'items',
      'purchases',
      'purchase-orders',
      'goods-receipts',
      'purchase-invoices',
      'payables',
      'attachments',
      'exports',
    ],
    ['view', 'create', 'update', 'delete', 'submit', 'confirm', 'cancel', 'print', 'export'],
  )
  await grantPermissions(
    connection,
    'inventory',
    [
      'dashboard',
      'global-search',
      'items',
      'warehouses',
      'units',
      'inventory',
      'stock-transfers',
      'stock-adjustments',
      'inventory-reports',
      'delivery-orders',
      'goods-receipts',
      'attachments',
      'exports',
    ],
    standardActions,
  )
  await grantPermissions(connection, 'auditor', modules, ['view', 'print', 'export'])

  for (let month = 1; month <= 12; month++) {
    const start = `2026-${String(month).padStart(2, '0')}-01`
    const end = new Date(Date.UTC(2026, month, 0)).toISOString().slice(0, 10)

    await connection.execute(
      `INSERT IGNORE INTO accounting_periods (
         company_id, year, month, start_date, end_date, status
       ) VALUES (1, 2026, ?, ?, ?, 'open')`,
      [month, start, end],
    )
  }
}
