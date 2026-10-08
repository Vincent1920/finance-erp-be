import { app } from '../app'
import { db } from '../config/database'
import type { RowDataPacket } from 'mysql2/promise'
import { ReportingService } from '../services/ReportingService'
import { EquityService } from '../services/EquityService'
import { ImportService } from '../services/ImportService'
import { PayrollFileService } from '../services/PayrollFileService'
import { mkdir } from 'node:fs/promises'

await mkdir('storage/demo-audit', { recursive: true })
const login = await app.request('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'demo.admin@finora.local', password: 'DemoFinance2026!' }),
})
const session = (await login.json()) as any
if (!session.data?.token) throw new Error('Login failed')
const headers = { authorization: `Bearer ${session.data.token}` },
  range = 'date_from=2026-01-01&date_to=2026-10-31',
  operationsRange = 'date_from=2026-01-01&date_to=2026-10-31',
  asOf = 'as_of_date=2026-10-31'
const source = await Bun.file('../finance-erp-fe/src/data/sidebar.ts').text()
const menus = [...source.matchAll(/\['([^']+)',\s*'([^']+)'/g)].map((m) => ({
  name: m[1]!,
  path: m[2]!,
}))
menus.unshift({ name: 'Dashboard', path: '/dashboard' }, { name: 'Pencarian', path: '/search' })
const [banks] = await db.query<RowDataPacket[]>(
  "SELECT id FROM bank_accounts WHERE company_id=1 AND code='BANK-DEMO-BCA'",
)
const bankFilter = '&bank_account_id=' + banks[0]!.id
const endpoints: Record<string, string[]> = {
  '/dashboard': ['/dashboard/summary'],
  '/search': ['/global-search?q=DEMO'],
  '/sales/orders': ['/sales/orders'],
  '/sales/invoices': ['/sales/invoices'],
  '/sales/settlements': ['/operations/receivable-settlements?' + operationsRange],
  '/sales/returns': ['/sales/returns'],
  '/sales/receivables': ['/reports/receivable-aging?' + asOf],
  '/purchases/orders': ['/purchases/orders'],
  '/purchases/invoices': ['/purchases/invoices'],
  '/purchases/settlements': ['/operations/payable-settlements?' + operationsRange],
  '/purchases/returns': ['/operations/purchase-returns'],
  '/purchases/payables': ['/reports/payable-aging?' + asOf],
  '/inventory/stock': ['/inventory/stock'],
  '/inventory/transfers': ['/operations/stock-transfers'],
  '/inventory/adjustments': ['/operations/stock-adjustments'],
  '/inventory/reports': ['/inventory/card?' + operationsRange],
  '/accounting/journals/new': ['/accounts'],
  '/accounting/journals': ['/journals'],
  '/accounting/opening-balances': ['/opening-balances'],
  '/accounting/equity': ['/equity/shareholders?' + asOf, '/equity/transactions?' + range],
  '/accounting/recurring-journals': ['/recurring-journals'],
  '/accounting/schedules': ['/accounting-schedules'],
  '/accounting/general-ledger': ['/reports/general-ledger?' + range],
  '/accounting/trial-balance': ['/reports/trial-balance?' + range],
  '/banking/accounts': ['/bank-accounts'],
  '/banking/statements': ['/operations/bank-statements?' + operationsRange + bankFilter],
  '/banking/reconciliation': ['/operations/bank-match-suggestions?' + operationsRange + bankFilter],
  '/banking/cash-book': ['/operations/cash-book?' + operationsRange + bankFilter],
  '/tax/reconciliation': ['/operations/tax-reconciliation?period=2026-09&scope=all'],
  '/payroll': ['/payroll?period=2026-10'],
  '/assets/fixed-assets': ['/operations/assets?' + asOf],
  '/assets/depreciation': ['/operations/assets?' + asOf],
  '/budgeting/budgets': ['/operations/budgets'],
  '/budgeting/budget-vs-actual': ['/reports/budget-vs-actual?' + range],
  '/reports/profit-loss': ['/reports/profit-loss?' + range],
  '/reports/balance-sheet': ['/reports/balance-sheet?' + asOf],
  '/reports/equity-changes': ['/equity/report?' + range],
  '/reports/cash-flow': ['/reports/cash-flow?' + range],
  '/reports/receivable-aging': ['/reports/receivable-aging?' + asOf],
  '/reports/payable-aging': ['/reports/payable-aging?' + asOf],
  '/reports/inventory': ['/reports/inventory?' + asOf],
  '/reports/subledger': ['/reports/subledger-reconciliation?' + asOf],
  '/approvals': ['/approvals'],
  '/transactions': ['/transactions?limit=100'],
  '/accounting/month-end': ['/month-end?' + asOf],
  '/accounting/closing': ['/period-closing'],
  '/accounting/year-end': ['/year-end'],
  '/system/data-import': ['/imports/config', '/imports'],
  '/system/users': ['/users'],
  '/system/roles': ['/roles', '/permissions'],
  '/system/audit-logs': ['/audit-logs'],
  '/system/error-logs': ['/error-logs'],
  '/system/backup': ['/operations/backups'],
  '/system/settings': [
    '/settings',
    '/settings/company',
    '/settings/account-mappings',
    '/settings/accounting-readiness',
    '/settings/sequences',
    '/operations/print-template?document_type=trial_balance',
  ],
}
const master: Record<string, string> = {
  accounts: 'accounts',
  periods: 'accounting-periods',
  customers: 'customers',
  suppliers: 'suppliers',
  items: 'items',
  warehouses: 'warehouses',
  units: 'units',
  'tax-codes': 'tax-codes',
  'cost-centers': 'cost-centers',
  projects: 'projects',
}
for (const [path, endpoint] of Object.entries(master))
  endpoints[`/master/${path}`] = [`/${endpoint}`]
const result: any = { date: new Date().toISOString(), menus: [], checks: [], counts: {} }
async function check(name: string, work: () => Promise<unknown>) {
  try {
    result.checks.push({ name, status: 'PASS', evidence: await work() })
  } catch (e) {
    result.checks.push({
      name,
      status: 'FAIL',
      evidence: e instanceof Error ? e.message : String(e),
    })
  }
}
try {
  await check('Impor CSV mutasi bank: tanggal, preview dan konfirmasi', async () => {
    const [users] = await db.query<RowDataPacket[]>('SELECT id FROM users WHERE email=?', [
      'demo.admin@finora.local',
    ])
    const actor = {
      id: Number(users[0]!.id),
      userId: Number(users[0]!.id),
      companyId: 1,
      roles: ['super-admin'],
      permissions: ['import.bank_statement'],
    }
    const [existing] = await db.query<RowDataPacket[]>(
      "SELECT id FROM bank_statements WHERE company_id=1 AND statement_number='DEMO-IMPORT-NOV'",
    )
    if (existing[0]) return { statementId: existing[0].id, reused: true }
    const [bank] = await db.query<RowDataPacket[]>(
      "SELECT current_balance FROM bank_accounts WHERE company_id=1 AND code='BANK-DEMO-BCA'",
    )
    const balance = Number(bank[0]!.current_balance) - 10000
    const csv = `bank_account_code,statement_number,transaction_date,description,reference,debit,credit,balance\nBANK-DEMO-BCA,DEMO-IMPORT-NOV,01/11/2026,Biaya bank dummy,DEMO-NOV-FEE,0,10000,${balance}\n`
    await Bun.write('storage/demo-audit/contoh-import-mutasi-bank.csv', csv)
    const imports = new ImportService(),
      file = new File([csv], 'contoh-import-mutasi-bank.csv', { type: 'text/csv' })
    const preview: any = await imports.preview(actor, 'bank_statement', file)
    const job = preview.job ?? preview
    if (!job.id) throw new Error(`Import preview shape ${JSON.stringify(Object.keys(preview))}`)
    const confirmed = await imports.confirm(actor, Number(job.id), {
      error_policy: 'all_or_nothing',
      import_as: 'draft',
      skip_duplicates: true,
    })
    return { jobId: job.id, preview, confirmed }
  })
  for (const menu of menus) {
    const calls = []
    for (const endpoint of endpoints[menu.path] ?? []) {
      const response = await app.request(`/api${endpoint}`, { headers })
      const payload = (await response.json()) as any
      calls.push({
        endpoint,
        status: response.status,
        ok: response.ok,
        message: response.ok ? null : payload.message,
      })
      if (!response.ok)
        console.log('FAIL API', menu.name, endpoint, response.status, payload.message)
    }
    result.menus.push({
      ...menu,
      apiStatus:
        calls.length && calls.every((c) => c.ok) ? 'PASS' : calls.length ? 'FAIL' : 'NOT_TESTED',
      calls,
    })
  }
  const reports = new ReportingService()
  await check('Neraca saldo seimbang', async () => {
    const report = await reports.trialBalance(1, { dateFrom: '2026-01-01', dateTo: '2026-10-31' })
    if (!report.balanced) throw new Error(JSON.stringify(report))
    return { difference: report.difference }
  })
  await check('Neraca seimbang', async () => {
    const report: any = await reports.balanceSheet(1, '2026-10-31')
    await Bun.write('storage/demo-audit/neraca.json', JSON.stringify(report, null, 2))
    if (!report.balanced) throw new Error(JSON.stringify(report))
    return { difference: report.difference }
  })
  await check('Rekonsiliasi GL dengan subledger', async () => {
    const report: any = await reports.subledger(1, '2026-10-31')
    await Bun.write(
      'storage/demo-audit/rekonsiliasi-subledger.json',
      JSON.stringify(report, null, 2),
    )
    if (report.some((r: any) => !r.balanced))
      throw new Error(JSON.stringify(report.filter((r: any) => !r.balanced)))
    return report
  })
  await check('Perubahan ekuitas cocok dengan neraca', async () => {
    const report = await new EquityService().report(1, '2026-01-01', '2026-10-31')
    await Bun.write('storage/demo-audit/ekuitas.json', JSON.stringify(report, null, 2))
    if (!report.reconciled) throw new Error(JSON.stringify(report))
    return { difference: report.difference, capitalControl: report.capitalControl }
  })
  const [runs] = await db.query<RowDataPacket[]>(
    'SELECT id,period FROM payroll_runs WHERE company_id=1 ORDER BY period',
  )
  for (const run of runs)
    for (const kind of ['bank', 'bpjs', 'pph21', 'payroll'])
      await check(`Ekspor payroll ${run.period} ${kind}`, async () => {
        const file: any = await new PayrollFileService().export(1, Number(run.id), kind)
        await Bun.write(
          `storage/demo-audit/${run.period}-${kind}.csv`,
          file.content ?? file.buffer ?? file.data,
        )
        return { file: file.fileName ?? file.filename }
      })
  for (const table of [
    'journals',
    'sales_invoices',
    'purchase_invoices',
    'customer_payments',
    'supplier_payments',
    'sales_returns',
    'purchase_returns',
    'stock_transfers',
    'stock_adjustments',
    'fixed_assets',
    'asset_depreciations',
    'payroll_employees',
    'payroll_runs',
    'bank_statements',
    'bank_reconciliations',
    'budgets',
    'accounting_schedules',
    'recurring_journals',
    'equity_transactions',
    'tax_report_rows',
    'tax_internal_rows',
    'import_jobs',
  ]) {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT COUNT(*) total FROM ${table} WHERE company_id=1`,
    )
    result.counts[table] = Number(rows[0]!.total)
  }
  await Bun.write('storage/demo-audit/menu-checks.json', JSON.stringify(result, null, 2))
  console.log(
    'Menu API',
    result.menus.length,
    'passed',
    result.menus.filter((m: any) => m.apiStatus === 'PASS').length,
  )
  console.log(
    JSON.stringify(
      result.checks.map((c: any) => ({
        name: c.name,
        status: c.status,
        evidence: c.status === 'FAIL' ? c.evidence : undefined,
      })),
      null,
      2,
    ),
  )
  console.log('Counts', JSON.stringify(result.counts))
} finally {
  await db.end()
}
