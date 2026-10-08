import { db, transaction } from '../config/database'
import { env } from '../config/env'
import type { RowDataPacket } from 'mysql2/promise'
import { BackupService } from '../services/BackupService'
import { runDemoSeed } from './seeds/demo.seed'

if (env.APP_ENV !== 'development') throw new Error('Demo refresh requires development')
const [companies] = await db.query<RowDataPacket[]>('SELECT id,name FROM companies')
if (
  companies.length !== 1 ||
  Number(companies[0]?.id) !== 1 ||
  companies[0]?.name !== 'PT Finora Indonesia'
)
  throw new Error('Refresh limited to the verified single local demo company')
const [tables] = await db.query<RowDataPacket[]>(
  `SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME`,
)
const [columns] = await db.query<RowDataPacket[]>(
  `SELECT TABLE_NAME table_name,COLUMN_NAME column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()`,
)
const [foreignKeys] = await db.query<RowDataPacket[]>(
  `SELECT TABLE_NAME child,COLUMN_NAME col,REFERENCED_TABLE_NAME parent,REFERENCED_COLUMN_NAME parent_col FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`,
)
const preserve = new Set([
  'companies',
  'migrations',
  'currencies',
  'company_currencies',
  'exchange_rates',
  'accounts',
  'account_mappings',
  'accounting_periods',
  'customers',
  'suppliers',
  'items',
  'item_units',
  'units',
  'tax_codes',
  'warehouses',
  'cost_centers',
  'projects',
  'bank_accounts',
  'bank_import_mappings',
  'bank_matching_rules',
  'fixed_asset_categories',
  'payroll_employees',
  'payroll_compensation_history',
  'payroll_policies',
  'payroll_ter_rates',
  'shareholders',
  'shareholder_holdings',
  'users',
  'roles',
  'permissions',
  'user_roles',
  'role_permissions',
  'settings',
  'document_templates',
  'user_saved_views',
  'approval_rules',
  'approval_rule_steps',
  'number_sequences',
  'audit_logs',
  'error_logs',
  'backup_jobs',
  'restore_jobs',
])
const cleared = tables.map((t) => String(t.name)).filter((t) => !preserve.has(t))
console.log('Transaction tables to clear:', cleared.join(', '))
if (!process.argv.includes('--apply')) {
  await db.end()
  process.exit(0)
}
const [users] = await db.execute<RowDataPacket[]>(
  'SELECT id FROM users WHERE company_id=1 AND email=?',
  ['demo.admin@finora.local'],
)
if (!users[0]) throw new Error('Demo admin missing')
const actor = { userId: Number(users[0].id) }
try {
  const backup = await new BackupService().create(1, 'full', actor)
  const file = await new BackupService().file(1, Number(backup.id))
  console.log('Backup retained:', file.path)
  await transaction(async (connection) => {
    await connection.query('SET FOREIGN_KEY_CHECKS=0')
    try {
      for (const table of cleared) {
        if (!/^[a-z_]+$/.test(table)) throw new Error('Unsafe table')
        await connection.query(`DELETE FROM \`${table}\``)
      }
      await connection.execute('UPDATE bank_accounts SET current_balance=0 WHERE company_id=1')
      await connection.execute(
        "UPDATE accounting_periods SET status='open',closed_at=NULL,closed_by=NULL,locked_at=NULL,locked_by=NULL WHERE company_id=1 AND year>=2026",
      )
      for (const fk of foreignKeys) {
        const [orphan] = await connection.query<RowDataPacket[]>(
          `SELECT COUNT(*) total FROM \`${fk.child}\` c LEFT JOIN \`${fk.parent}\` p ON p.\`${fk.parent_col}\`=c.\`${fk.col}\` WHERE c.\`${fk.col}\` IS NOT NULL AND p.\`${fk.parent_col}\` IS NULL`,
        )
        if (Number(orphan[0]?.total) > 0) throw new Error(`Orphan ${fk.child}.${fk.col}`)
      }
    } finally {
      await connection.query('SET FOREIGN_KEY_CHECKS=1')
    }
  })
  await runDemoSeed({ printSummary: false })
  console.log('Baseline dummy refreshed; backup:', file.path)
} finally {
  await db.end()
}
