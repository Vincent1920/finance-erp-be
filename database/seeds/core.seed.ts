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
  'accounts',
  'customers',
  'suppliers',
  'items',
  'sales',
  'purchases',
  'inventory',
  'accounting',
  'banking',
  'reports',
  'users',
  'roles',
  'audit',
  'settings',
] as const

const actions = [
  'view',
  'create',
  'update',
  'delete',
  'approve',
  'post',
  'print',
  'export',
] as const

export async function seedCore(connection: SeedConnection) {
  await connection.execute(
    `INSERT INTO companies (id, name, legal_name, base_currency, fiscal_year_start)
     VALUES (1, 'PT Finora Indonesia', 'PT Finora Indonesia', 'IDR', 1)
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
  )

  for (const [name, slug] of roles) {
    await connection.execute('INSERT IGNORE INTO roles (name, slug) VALUES (?, ?)', [name, slug])
  }

  for (const module of modules) {
    for (const action of actions) {
      await connection.execute(
        'INSERT IGNORE INTO permissions (module, action, name, slug) VALUES (?, ?, ?, ?)',
        [module, action, `${action} ${module}`, `${module}.${action}`],
      )
    }
  }

  const password = await hashPassword('password')

  await connection.execute(
    `INSERT INTO users (id, company_id, name, email, password, status)
     VALUES (1, 1, 'Super Admin', 'admin@financeerp.local', ?, 'active')
     ON DUPLICATE KEY UPDATE
       name = VALUES(name), password = VALUES(password), status = 'active'`,
    [password],
  )
  await connection.execute(
    `INSERT IGNORE INTO user_roles (user_id, role_id)
     SELECT 1, id FROM roles WHERE slug = 'super-admin'`,
  )
  await connection.execute(
    `INSERT IGNORE INTO role_permissions (role_id, permission_id)
     SELECT r.id, p.id
     FROM roles r
     CROSS JOIN permissions p
     WHERE r.slug = 'super-admin'`,
  )

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
