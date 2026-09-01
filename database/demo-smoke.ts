import { app } from '../app'
import { db } from '../config/database'

const requests = [
  '/api/auth/me',
  '/api/dashboard/summary',
  '/api/accounts?search=1102',
  '/api/customers?search=CUST-DEMO-001',
  '/api/suppliers?search=SUP-DEMO-001',
  '/api/items?search=ITEM-DEMO-001',
  '/api/warehouses',
  '/api/units',
  '/api/tax-codes',
  '/api/cost-centers',
  '/api/projects',
  '/api/bank-accounts',
  '/api/accounting-periods',
  '/api/purchases/orders?search=DEMO',
  '/api/purchases/invoices?search=DEMO',
  '/api/purchases/receipts?search=DEMO',
  '/api/sales/orders?search=DEMO',
  '/api/sales/invoices?search=DEMO',
  '/api/sales/returns?search=DEMO',
  '/api/inventory/stock',
  '/api/journals?search=DEMO',
  '/api/reports/trial-balance?date_from=2026-01-01&date_to=2026-09-30',
  '/api/reports/general-ledger?date_from=2026-01-01&date_to=2026-09-30',
  '/api/reports/profit-loss?date_from=2026-01-01&date_to=2026-09-30',
  '/api/reports/balance-sheet?as_of_date=2026-09-30',
  '/api/reports/cash-flow?date_from=2026-01-01&date_to=2026-09-30',
  '/api/reports/receivable-aging?as_of_date=2026-09-30',
  '/api/reports/payable-aging?as_of_date=2026-09-30',
  '/api/reports/inventory?as_of_date=2026-09-30',
  '/api/imports/config',
  '/api/transactions?search=DEMO&limit=100',
  '/api/global-search?q=CUST-DEMO-001',
  '/api/global-search?q=INV-DEMO-001',
  '/api/global-search?q=ITEM-DEMO-001',
  '/api/global-search?q=1102',
  '/api/global-search?q=PUR-DEMO-001',
  '/api/global-search?q=JRN-DEMO-001',
] as const

export async function runDemoSmoke() {
  const login = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'demo.admin@finora.local', password: 'DemoFinance2026!' }),
  })
  const loginBody = (await login.json()) as { data?: { token?: string }; message?: string }
  if (!login.ok || !loginBody.data?.token)
    throw new Error(`Demo login gagal (${login.status}): ${loginBody.message}`)
  let transactionRows: Array<{ id: number; entity_type: string }> = []
  for (const path of requests) {
    const response = await app.request(path, {
      headers: { authorization: `Bearer ${loginBody.data.token}` },
    })
    if (!response.ok)
      throw new Error(`${path} gagal (${response.status}): ${await response.text()}`)
    const payload = (await response.json()) as { data?: unknown[] | Record<string, unknown> }
    if (Array.isArray(payload.data) && payload.data.length === 0)
      throw new Error(`${path} tidak mengembalikan data demo`)
    if (path.startsWith('/api/transactions'))
      transactionRows = payload.data as Array<{ id: number; entity_type: string }>
    if (path.startsWith('/api/global-search')) {
      const results = payload.data as Array<{
        category?: string
        id?: number
        title?: string
        path?: string
      }>
      if (results.some((result) => !result.category || !result.id || !result.title || !result.path))
        throw new Error(`${path} mengembalikan kontrak hasil yang tidak lengkap`)
    }
    console.info('PASS', path)
  }
  const expectedTypes = [
    'sales_invoice',
    'purchase_invoice',
    'journal',
    'sales_order',
    'purchase_order',
    'goods_receipt',
  ]
  for (const type of expectedTypes) {
    if (!transactionRows.some((entry) => entry.entity_type === type))
      throw new Error(`Transaction Browser tidak mengembalikan tipe ${type}`)
  }
  console.info('PASS transaction types', expectedTypes.join(', '), `(${transactionRows.length} rows)`)
}

if (import.meta.main) {
  try {
    await runDemoSmoke()
  } finally {
    await db.end()
  }
}
