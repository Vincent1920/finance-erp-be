import type { RowDataPacket } from 'mysql2/promise'

import { hashPassword } from '../../utils/password'
import type { SeedConnection } from './types'

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

export async function seedCore(connection: SeedConnection) {
  await connection.execute(
    `INSERT INTO companies (
       id,
       name,
       legal_name,
       base_currency,
       fiscal_year_start
     )
     VALUES (
       1,
       'PT Finora Indonesia',
       'PT Finora Indonesia',
       'IDR',
       1
     )
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       legal_name = VALUES(legal_name),
       base_currency = VALUES(base_currency),
       fiscal_year_start = VALUES(fiscal_year_start)`,
  )

  await connection.execute(
    `INSERT INTO roles (
       name,
       slug,
       is_system
     )
     VALUES (
       'Super Admin',
       'super-admin',
       TRUE
     )
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       is_system = TRUE`,
  )

  for (const module of modules) {
    for (const action of actions) {
      await connection.execute(
        `INSERT IGNORE INTO permissions (
           module,
           action,
           name,
           slug
         )
         VALUES (?, ?, ?, ?)`,
        [module, action, `${action} ${module}`, `${module}.${action}`],
      )
    }
  }

  const demoPasswordHash = await hashPassword('DemoFinance2026!')
 const admin123PasswordHash = await hashPassword('Admin123')
 
  await connection.execute(
    `INSERT INTO users (
       company_id,
       name,
       email,
       password,
       status,
       password_changed_at
     )
     VALUES (
       1,
       'Administrator',
       'admin123@gmial.com',
       ?,
       'active',
       CURRENT_TIMESTAMP
     )
     ON DUPLICATE KEY UPDATE
       company_id = VALUES(company_id),
       name = VALUES(name),
       password = VALUES(password),
       status = VALUES(status),
       password_changed_at = CURRENT_TIMESTAMP`,
    [admin123PasswordHash],
  )

  const [admin123Rows] = await connection.execute<
    (RowDataPacket & { id: number })[]
  >(
    `SELECT id
       FROM users
      WHERE email = ?
      LIMIT 1`,
    ['admin123@gmial.com'],
  )

  const admin123UserId = admin123Rows[0]?.id

  if (!admin123UserId) {
    throw new Error('Seeder gagal menemukan akun admin123')
  }

  await connection.execute(
    `DELETE FROM user_roles
      WHERE user_id = ?`,
    [admin123UserId],
  )

  await connection.execute(
    `INSERT INTO user_roles (
       user_id,
       role_id
     )
     SELECT ?, id
       FROM roles
      WHERE slug = 'super-admin'
      LIMIT 1`,
    [admin123UserId],
  )

  await connection.execute(
    `INSERT INTO users (
       company_id,
       name,
       email,
       password,
       status,
       password_changed_at
     )
     VALUES (
       1,
       'Finora Demo Administrator',
       'demo.admin@finora.local',
       ?,
       'active',
       CURRENT_TIMESTAMP
     )
     ON DUPLICATE KEY UPDATE
       company_id = VALUES(company_id),
       name = VALUES(name),
       password = VALUES(password),
       status = VALUES(status),
       password_changed_at = CURRENT_TIMESTAMP`,
    [demoPasswordHash],
  )

  const [demoRows] = await connection.execute<
    (RowDataPacket & { id: number })[]
  >(
    `SELECT id
       FROM users
      WHERE email = ?
      LIMIT 1`,
    ['demo.admin@finora.local'],
  )

  const demoUserId = demoRows[0]?.id

  if (!demoUserId) {
    throw new Error('Seeder gagal menemukan akun demo')
  }

  await connection.execute(
    `DELETE FROM user_roles
      WHERE user_id = ?`,
    [demoUserId],
  )

  await connection.execute(
    `INSERT INTO user_roles (
       user_id,
       role_id
     )
     SELECT ?, id
       FROM roles
      WHERE slug = 'super-admin'
      LIMIT 1`,
    [demoUserId],
  )

  await connection.execute(
    `INSERT IGNORE INTO role_permissions (
       role_id,
       permission_id
     )
     SELECT r.id, p.id
       FROM roles r
       CROSS JOIN permissions p
      WHERE r.slug = 'super-admin'`,
  )

  for (let month = 1; month <= 12; month++) {
    const startDate = `2026-${String(month).padStart(2, '0')}-01`
    const endDate = new Date(Date.UTC(2026, month, 0))
      .toISOString()
      .slice(0, 10)

    await connection.execute(
      `INSERT IGNORE INTO accounting_periods (
         company_id,
         year,
         month,
         start_date,
         end_date,
         status
       )
       VALUES (
         1,
         2026,
         ?,
         ?,
         ?,
         'open'
       )`,
      [month, startDate, endDate],
    )
  }

}
