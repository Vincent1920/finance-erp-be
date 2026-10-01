/** Integration verification in an isolated, disposable schema. Never seeds the user's database. */
import 'dotenv/config'
import mysql from 'mysql2/promise'
import assert from 'node:assert/strict'
import { unlink } from 'node:fs/promises'
const originalDatabase = process.env.DB_NAME
const schema = `finora_verify_${Date.now()}_${Math.floor(Math.random() * 100000)}`
if (process.env.APP_ENV === 'production')
  throw new Error('Integration verification is development-only')
const admin = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  multipleStatements: true,
})
await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
process.env.DB_NAME = schema
const { db, transaction } = await import('../config/database')
let checks = 0
function check(value: unknown, message: string) {
  assert.ok(value, message)
  checks++
  console.log(`PASS ${message}`)
}
async function rejects(work: () => Promise<unknown>, message: string) {
  let rejected = false
  try {
    await work()
  } catch {
    rejected = true
  }
  check(rejected, message)
}
const key = () => crypto.randomUUID()
try {
  const { migrations } = await import('./migrations')
  for (const migration of migrations) await migration.up(db)
  const { seedCore } = await import('./seeds/core.seed')
  await transaction((c) => seedCore(c))
  const [users] = await db.query<any[]>('SELECT id FROM users ORDER BY id LIMIT 1'),
    actor = { userId: Number(users[0].id), requestId: 'operational-verify' }
  const ids: Record<string, number> = {}
  for (const [code, name, type, normal] of [
    ['1101', 'Cash', 'asset', 'debit'],
    ['1102', 'Bank', 'asset', 'debit'],
    ['1130', 'AR', 'asset', 'debit'],
    ['1140', 'Inventory', 'asset', 'debit'],
    ['1150', 'Input VAT', 'asset', 'debit'],
    ['1201', 'Equipment', 'asset', 'debit'],
    ['1202', 'Accumulated depreciation', 'asset', 'credit'],
    ['2101', 'AP', 'liability', 'credit'],
    ['2201', 'Output VAT', 'liability', 'credit'],
    ['2202', 'Withholding', 'liability', 'credit'],
    ['3100', 'Equity', 'equity', 'credit'],
    ['4100', 'Revenue', 'revenue', 'credit'],
    ['5100', 'COGS', 'cogs', 'debit'],
    ['6100', 'Expense', 'expense', 'debit'],
    ['6400', 'Depreciation', 'expense', 'debit'],
  ]) {
    const [r] = await db.execute<any>(
      'INSERT INTO accounts(company_id,code,name,account_type,normal_balance,is_posting,is_header,is_active) VALUES(1,?,?,?,?,TRUE,FALSE,TRUE)',
      [code!, name!, type!, normal!],
    )
    ids[code!] = r.insertId
  }
  const insert = async (sql: string, values: any[] = []) =>
    Number((await db.execute<any>(sql, values))[0].insertId)
  const unit = await insert(
    "INSERT INTO units(company_id,code,name,symbol) VALUES(1,'PCS','Piece','pcs')",
  )
  const warehouse = await insert(
      "INSERT INTO warehouses(company_id,code,name) VALUES(1,'A','Warehouse A')",
    ),
    warehouse2 = await insert(
      "INSERT INTO warehouses(company_id,code,name) VALUES(1,'B','Warehouse B')",
    )
  const supplier = await insert(
    "INSERT INTO suppliers(company_id,code,name,currency,tax_number,payable_account_id) VALUES(1,'SUP','Supplier','IDR','0123456789012345',?)",
    [ids['2101']],
  )
  const customer = await insert(
    "INSERT INTO customers(company_id,code,name,currency,tax_number,receivable_account_id) VALUES(1,'CUS','Customer','IDR','0123456789012345',?)",
    [ids['1130']],
  )
  const item = await insert(
    "INSERT INTO items(company_id,sku,name,item_type,unit_id,sales_account_id,inventory_account_id,cogs_account_id,purchase_account_id,sales_price,purchase_price) VALUES(1,'ITEM','Stock item','inventory',?,?,?,?,?,200,100)",
    [unit, ids['4100'], ids['1140'], ids['5100'], ids['6100']],
  )
  const shippingItem = await insert(
    "INSERT INTO items(company_id,sku,name,item_type,unit_id,purchase_account_id,sales_price,purchase_price) VALUES(1,'SHIP','Biaya kirim','service',?, ?,0,100)",
    [unit, ids['6100']],
  )
  const vat = await insert(
    "INSERT INTO tax_codes(company_id,code,name,tax_type,rate,input_tax_account_id,output_tax_account_id) VALUES(1,'VAT','VAT','vat',11,?,?)",
    [ids['1150'], ids['2201']],
  )
  const withholding = await insert(
    "INSERT INTO tax_codes(company_id,code,name,tax_type,rate,output_tax_account_id) VALUES(1,'WHT','PPh final','withholding',10,?)",
    [ids['2202']],
  )
  const bank = await insert(
    "INSERT INTO bank_accounts(company_id,code,bank_name,account_number,account_name,currency,gl_account_id,created_by) VALUES(1,'BANK','Test Bank','123','Test','IDR',?,?)",
    [ids['1102'], actor.userId],
  )
  const { PurchaseInvoiceService } = await import('../services/PurchaseInvoiceService'),
    purchase = new PurchaseInvoiceService()
  const { purchaseInvoiceSchema } = await import('../validators/purchase-invoice.validator')
  const pi = await purchase.create(
    1,
    purchaseInvoiceSchema.parse({
      supplier_invoice_number: 'TEST-PI',
      invoice_date: '2026-01-02',
      due_date: '2026-02-02',
      supplier_id: supplier,
      warehouse_id: warehouse,
      lines: [
        { item_id: item, quantity: 10, unit_id: unit, unit_price: 100, tax_code_id: vat },
        {
          item_id: shippingItem,
          quantity: 1,
          unit_id: unit,
          unit_price: 100,
          withholding_tax_id: withholding,
        },
      ],
    }),
    actor,
  )
  await purchase.submit(pi.id, 1, actor)
  await purchase.approve(pi.id, 1, actor)
  await purchase.post(pi.id, 1, actor)
  const invoice: any = await purchase.get(pi.id, 1)
  check(
    Number(invoice.grand_total) === 1200 && Number(invoice.withholding_amount) === 10,
    'Purchase invoice: PPh hanya memotong biaya kirim, bukan nilai barang',
  )
  const { SettlementService } = await import('../services/SettlementService'),
    settlements = new SettlementService()
  const payment = {
    request_key: key(),
    invoice_id: pi.id,
    date: '2026-01-03',
    amount: '400.00',
    cash_account_id: ids['1102']!,
    bank_account_id: bank,
    reference: 'PAY-1',
  }
  const first = await settlements.post(1, false, payment, actor),
    replay = await settlements.post(1, false, payment, actor)
  check(first.id === replay.id, 'Identical payment retry returns existing payment')
  await rejects(
    () => settlements.post(1, false, { ...payment, amount: '500.00' }, actor),
    'Reusing payment key for different amount rejected',
  )
  await rejects(
    () => settlements.post(1, false, { ...payment, request_key: key(), amount: '801.00' }, actor),
    'Overpayment rejected',
  )
  check(
    Number(((await purchase.get(pi.id, 1)) as any).outstanding_amount) === 800,
    'Invoice detail reflects partial settlement',
  )
  const { PurchaseReturnService } = await import('../services/PurchaseReturnService'),
    returns = new PurchaseReturnService()
  const sourceLine = Number(invoice.lines[0].id)
  const ret = await returns.post(
    1,
    {
      request_key: key(),
      invoice_id: pi.id,
      date: '2026-01-04',
      reference: 'RET',
      reason: 'Return two damaged items',
      return_stock: true,
      adjustment_account_id: ids['6100'],
      lines: [{ invoice_line_id: sourceLine, quantity: '2.0000' }],
    },
    actor,
  )
  check(
    Number(((await purchase.get(pi.id, 1)) as any).outstanding_amount) === 578,
    'Purchase return reverses proportional PPN/PPh and reduces outstanding',
  )
  await rejects(
    () =>
      returns.post(
        1,
        {
          request_key: key(),
          invoice_id: pi.id,
          date: '2026-01-04',
          reference: 'RET',
          reason: 'Too many items',
          return_stock: true,
          lines: [{ invoice_line_id: sourceLine, quantity: '9.0000' }],
        },
        actor,
      ),
    'Return exceeding remaining invoice quantity rejected',
  )
  await settlements.post(
    1,
    false,
    { ...payment, request_key: key(), date: '2026-01-05', amount: '578.00', reference: 'PAY-2' },
    actor,
  )
  check(
    ((await purchase.get(pi.id, 1)) as any).status === 'paid',
    'Multiple payments settle one purchase invoice',
  )
  const { StockOperationService } = await import('../services/StockOperationService'),
    stock = new StockOperationService()
  await stock.post(
    1,
    true,
    {
      request_key: key(),
      date: '2026-01-06',
      item_id: item,
      warehouse_id: warehouse,
      to_warehouse_id: warehouse2,
      quantity: '3.0000',
      reason: 'Transfer to branch',
      reference: 'MOVE',
    },
    actor,
  )
  await stock.post(
    1,
    false,
    {
      request_key: key(),
      date: '2026-01-07',
      item_id: item,
      warehouse_id: warehouse,
      actual_quantity: '4.0000',
      gain_loss_account_id: ids['6100'],
      reason: 'Physical stock count',
      reference: 'COUNT',
    },
    actor,
  )
  const [balances] = await db.query<any[]>(
    'SELECT SUM(quantity) quantity,SUM(total_value) value FROM inventory_balances WHERE company_id=1',
  )
  check(
    Number(balances[0].quantity) === 7 && Number(balances[0].value) === 700,
    'Transfer preserves value; adjustment posts physical difference',
  )
  const box = await insert(
    "INSERT INTO units(company_id,code,name,symbol) VALUES(1,'BOX','Box','box')",
  )
  await db.execute(
    'INSERT INTO item_units(company_id,item_id,unit_id,factor_to_stock) VALUES(1,?,?,10)',
    [item, box],
  )
  const item2 = await insert(
    "INSERT INTO items(company_id,sku,name,item_type,unit_id,sales_account_id,inventory_account_id,cogs_account_id,purchase_account_id,sales_price,purchase_price) VALUES(1,'ITEM2','Second stock item','inventory',?,?,?,?,?,100,50)",
    [unit, ids['4100'], ids['1140'], ids['5100'], ids['6100']],
  )
  await db.execute(
    'INSERT INTO item_units(company_id,item_id,unit_id,factor_to_stock) VALUES(1,?,?,1)',
    [item2, unit],
  )
  const { InventoryCostingService } = await import('../services/InventoryCostingService')
  await transaction((connection) =>
    new InventoryCostingService().applyMovement(connection, {
      companyId: 1,
      itemId: item2,
      warehouseId: warehouse,
      direction: 'in',
      quantity: '5',
      unitCost: '50',
      transactionType: 'opening_test',
      transactionId: 1,
      transactionNumber: 'OPEN',
      movementDate: '2026-01-01',
      postingKey: 'opening-test:item2',
      userId: actor.userId,
    }),
  )
  const batchTransfer = await stock.post(
    1,
    true,
    {
      request_key: key(),
      date: '2026-01-07',
      warehouse_id: warehouse,
      to_warehouse_id: warehouse2,
      reason: 'Multi-item transfer',
      reference: 'BATCH',
      lines: [
        { item_id: item, unit_id: box, quantity: '0.1' },
        { item_id: item2, unit_id: unit, quantity: '1.0' },
      ],
    },
    actor,
  )
  const [batchLines] = await db.query<any[]>(
    'SELECT quantity,stock_quantity FROM stock_transfer_lines WHERE stock_transfer_id=? ORDER BY line_number',
    [batchTransfer.id],
  )
  check(
    batchLines.length === 2 && Number(batchLines[0].stock_quantity) === 1,
    'Multi-item transfer converts transaction units to stock units',
  )
  await stock.reverse(
    1,
    true,
    batchTransfer.id,
    { request_key: key(), date: '2026-01-08', reason: 'Reverse batch transfer' },
    actor,
  )
  check(
    (await stock.list(1, true)).some(
      (row) => Number(row.id) === batchTransfer.id && row.status === 'reversed',
    ),
    'Multi-item stock transfer can be reversed safely',
  )
  const { SalesInvoiceService } = await import('../services/SalesInvoiceService'),
    sales = new SalesInvoiceService(),
    { salesInvoiceSchema } = await import('../validators/sales-invoice.validator')
  const si = await sales.create(
    1,
    salesInvoiceSchema.parse({
      invoice_date: '2026-01-08',
      due_date: '2026-02-08',
      customer_id: customer,
      warehouse_id: warehouse,
      lines: [{ item_id: item, quantity: 1, unit_id: unit, unit_price: 200, tax_code_id: vat }],
    }),
    actor,
  )
  await sales.submit(si.id, 1, actor)
  await sales.approve(si.id, 1, actor)
  await sales.post(si.id, 1, actor)
  for (const amount of ['100.00', '122.00'])
    await settlements.post(
      1,
      true,
      { ...payment, request_key: key(), invoice_id: si.id, date: '2026-01-09', amount },
      actor,
    )
  check(
    ((await sales.get(si.id, 1)) as any).status === 'paid',
    'Multiple receipts settle one sales invoice',
  )
  const multiInvoices: number[] = []
  for (const [day, price] of [
    ['10', 50],
    ['11', 75],
  ] as const) {
    const created = await sales.create(
      1,
      salesInvoiceSchema.parse({
        invoice_date: `2026-01-${day}`,
        due_date: `2026-02-${day}`,
        customer_id: customer,
        warehouse_id: warehouse,
        lines: [{ item_id: item, quantity: 1, unit_id: unit, unit_price: price }],
      }),
      actor,
    )
    await sales.submit(created.id, 1, actor)
    await sales.approve(created.id, 1, actor)
    await sales.post(created.id, 1, actor)
    multiInvoices.push(created.id)
  }
  const multiReceipt = await settlements.post(
    1,
    true,
    {
      request_key: key(),
      date: '2026-01-12',
      reference: 'MULTI-INVOICE',
      cash_account_id: ids['1102']!,
      bank_account_id: bank,
      allocations: [
        { invoice_id: multiInvoices[0]!, amount: '50.00' },
        { invoice_id: multiInvoices[1]!, amount: '75.00' },
      ],
    },
    actor,
  )
  const multiRows = await settlements.list(1, true, { search: multiReceipt.number })
  check(
    multiRows.length === 2 &&
      multiRows.every((row) => row.status === 'posted') &&
      (await Promise.all(multiInvoices.map((id) => sales.get(id, 1)))).every(
        (invoice: any) => invoice.status === 'paid',
      ),
    'One customer receipt settles multiple invoices with separate allocations',
  )
  const creditReturn = await returns.post(
    1,
    {
      request_key: key(),
      invoice_id: pi.id,
      date: '2026-01-10',
      reference: 'RET-CREDIT',
      reason: 'Return after invoice was fully paid',
      return_stock: true,
      adjustment_account_id: ids['6100'],
      lines: [{ invoice_line_id: sourceLine, quantity: '1.0' }],
    },
    actor,
  )
  const { CreditService } = await import('../services/CreditService'),
    creditService = new CreditService()
  const supplierCredits = await creditService.list(1, false, supplier)
  check(
    supplierCredits.length === 1 && Number(supplierCredits[0].remaining_amount) === 111,
    'Paid purchase return creates supplier credit balance',
  )
  const pi2 = await purchase.create(
    1,
    purchaseInvoiceSchema.parse({
      supplier_invoice_number: 'TEST-PI-2',
      invoice_date: '2026-01-10',
      due_date: '2026-02-10',
      supplier_id: supplier,
      warehouse_id: warehouse,
      lines: [{ item_id: item2, quantity: 2, unit_id: unit, unit_price: 50 }],
    }),
    actor,
  )
  await purchase.submit(pi2.id, 1, actor)
  await purchase.approve(pi2.id, 1, actor)
  await purchase.post(pi2.id, 1, actor)
  const applied = await creditService.apply(
    1,
    false,
    {
      request_key: key(),
      date: '2026-01-10',
      reference: 'APPLY-CREDIT',
      credit_id: Number(supplierCredits[0].id),
      invoice_id: pi2.id,
      amount: '100.00',
    },
    actor,
  )
  check(
    ((await purchase.get(pi2.id, 1)) as any).status === 'paid',
    'Supplier credit can settle another invoice',
  )
  await creditService.reverse(
    1,
    applied.id,
    { request_key: key(), date: '2026-01-11', reason: 'Reverse credit application' },
    actor,
  )
  check(
    Number(((await purchase.get(pi2.id, 1)) as any).outstanding_amount) === 100,
    'Credit application reversal restores invoice balance',
  )
  const refund = await creditService.refund(
    1,
    false,
    {
      request_key: key(),
      date: '2026-01-11',
      reference: 'SUPPLIER-REFUND',
      credit_id: Number(supplierCredits[0].id),
      cash_account_id: ids['1102']!,
      bank_account_id: bank,
      amount: '50.00',
    },
    actor,
  )
  await creditService.reverse(
    1,
    refund.id,
    { request_key: key(), date: '2026-01-12', reason: 'Reverse supplier refund' },
    actor,
  )
  await returns.reverse(
    1,
    creditReturn.id,
    {
      request_key: key(),
      date: '2026-01-12',
      reason: 'Reverse paid return after clearing credit use',
    },
    actor,
  )
  check(
    (await creditService.list(1, false, supplier))[0]?.status === 'void',
    'Credit source can reverse only after applications and refunds are reversed',
  )
  const { ReportingService } = await import('../services/ReportingService'),
    reports = new ReportingService()
  const aging = await reports.aging(1, 'payable', '2026-01-03')
  check(
    Number(aging.total) === 800 && Number(aging.buckets.current) === 800,
    'Historical aging retains unpaid, not-yet-due amount before later return/payments',
  )
  const reconciliation = await reports.subledger(1, '2026-01-31')
  check(
    reconciliation.length >= 4 && reconciliation.every((row) => row.accountCode && row.accountName),
    'Subledger reconciliation separates control account code and name',
  )
  const { InventoryService } = await import('../services/InventoryService'),
    inventory = new InventoryService()
  const card = await inventory.card(1, {
    date_from: '2026-01-01',
    date_to: '2026-01-31',
    item_id: item,
  })
  check(
    card.rows.length >= 5 && card.rows.every((r) => r.sku && r.item_name),
    'Stock mutation report separates item code/name and computes balances',
  )
  const openingCard = await inventory.card(1, {
    date_from: '2026-01-02',
    date_to: '2026-01-06',
    item_id: item2,
  })
  check(
    openingCard.rows.length === 1 &&
      openingCard.rows[0]!.row_kind === 'opening' &&
      Number(openingCard.rows[0]!.chronological_quantity) === 5,
    'Stock mutation report includes an opening row for stock without period movement',
  )
  const multiItemCard = await inventory.card(1, {
    date_from: '2026-01-01',
    date_to: '2026-01-31',
    item_ids: [item, item2],
  })
  check(
    new Set(multiItemCard.rows.map((row) => Number(row.item_id))).size === 2,
    'Stock mutation report accepts multiple selected items',
  )
  check(
    card.rows.every(
      (r) => Number(r.smallest_quantity_in) === Number(r.quantity_in) && r.smallest_unit_symbol,
    ),
    'Smallest unit report uses default one-to-one conversion',
  )
  const ledger = await reports.generalLedger(1, {
    dateFrom: '2026-01-01',
    dateTo: '2026-01-31',
    accountId: ids['1102'],
  })
  const filtered = await reports.generalLedger(1, {
    dateFrom: '2026-01-01',
    dateTo: '2026-01-31',
    accountId: ids['1102'],
    reference: first.number,
  })
  check(
    filtered.rows.length === 1 &&
      Number(filtered.rows[0]!.running_balance) ===
        Number(ledger.rows.find((r) => r.id === filtered.rows[0]!.id)!.running_balance),
    'Ledger text filter preserves true running balance',
  )
  const { FixedAssetService } = await import('../services/FixedAssetService'),
    assets = new FixedAssetService()
  const asset = await assets.create(
    1,
    {
      request_key: key(),
      code: 'FA-1',
      name: 'Test equipment',
      date: '2026-01-01',
      in_service_date: '2026-01-01',
      cost: '1200.00',
      salvage_value: '0.00',
      life_months: 12,
      asset_account_id: ids['1201']!,
      accumulated_account_id: ids['1202']!,
      expense_account_id: ids['6400']!,
      counterpart_account_id: ids['1101']!,
      already_recorded: false,
      location: 'Office',
      serial_number: '001',
      reference: 'FA',
    },
    actor,
  )
  const depInput = { request_key: key(), asset_id: asset.id, date: '2026-01-31' }
  const januaryDepreciation = await assets.depreciate(1, depInput, actor)
  await assets.depreciate(1, depInput, actor)
  await rejects(
    () => assets.depreciate(1, { ...depInput, request_key: key() }, actor),
    'Duplicate depreciation period rejected',
  )
  const februaryDepreciation = await assets.depreciate(
    1,
    { request_key: key(), asset_id: asset.id, date: '2026-02-28' },
    actor,
  )
  check(
    Number((await assets.list(1, '2026-01-31'))[0]!.book_value) === 1100,
    'Asset historical book value ignores future depreciation',
  )
  await assets.reverseDepreciation(
    1,
    februaryDepreciation.id,
    { request_key: key(), date: '2026-03-01', reason: 'Reverse latest depreciation' },
    actor,
  )
  await assets.reverseDepreciation(
    1,
    januaryDepreciation.id,
    { request_key: key(), date: '2026-03-01', reason: 'Reverse first depreciation' },
    actor,
  )
  const reversedAsset = await assets.reverseAsset(
    1,
    asset.id,
    { request_key: key(), date: '2026-03-01', reason: 'Reverse asset acquisition' },
    actor,
  )
  check(
    reversedAsset.status === 'inactive',
    'Asset depreciation and acquisition can be reversed in safe order',
  )
  const { BudgetService } = await import('../services/BudgetService'),
    budgets = new BudgetService()
  const budget = await budgets.create(
    1,
    {
      request_key: key(),
      name: 'Operating plan',
      year: 2026,
      notes: 'Monthly plan',
      lines: [{ account_id: ids['6100']!, amounts: Array(12).fill('100.00') }],
    },
    actor,
  )
  const budgetDetail = await budgets.detail(1, budget.id, '2026-01-31')
  check(
    Number(budgetDetail.rows[0]!.actual) > 0 && budgetDetail.unbudgeted.length > 0,
    'Budget uses posted actuals and identifies unbudgeted accounts',
  )
  await rejects(
    () => budgets.approve(1, { request_key: key(), id: budget.id }, actor),
    'Budget maker cannot self-approve without explicit setting',
  )
  const { BankingService } = await import('../services/BankingService'),
    banking = new BankingService()
  await banking.create(
    1,
    {
      request_key: key(),
      bank_account_id: bank,
      number: 'ST-1',
      date_from: '2026-01-03',
      date_to: '2026-01-05',
      opening_balance: 0,
      closing_balance: -978,
      lines: [
        {
          date: '2026-01-03',
          description: 'Supplier payment',
          reference: 'PAY-1',
          debit: '400.00',
          credit: '0.00',
          balance: -400,
        },
        {
          date: '2026-01-05',
          description: 'Supplier payment 2',
          reference: 'PAY-2',
          debit: '578.00',
          credit: '0.00',
          balance: -978,
        },
      ],
    },
    actor,
  )
  const filter = { date_from: '2026-01-03', date_to: '2026-01-05', bank_account_id: bank },
    statement = await banking.statements(1, filter),
    book = await banking.cash(1, filter)
  check(
    Number(statement[0]!.movement) === -400 && Number(book.summary!.closing) === -978,
    'Bank mutation convention and book closing balance agree',
  )
  const suggestions = await banking.suggestions(1, filter)
  check(
    suggestions.length === 2 && suggestions.every((row: any) => row.journal_line_id),
    'Automatic bank matching suggests exact amount and direction candidates',
  )
  for (const line of statement) {
    const j = book.rows.find((r) => Number(r.credit) === Math.abs(Number(line.movement)))!
    await banking.match(
      1,
      { request_key: key(), statement_line_id: Number(line.id), journal_line_id: Number(j.id) },
      actor,
    )
  }
  const [rec] = await db.query<any[]>(
    'SELECT status,difference FROM bank_reconciliations WHERE company_id=1',
  )
  check(
    rec[0].status === 'completed' && Number(rec[0].difference) === 0,
    'Bank reconciliation completes only when all lines and balances match',
  )
  await banking.unmatch(
    1,
    { request_key: key(), statement_line_id: Number(statement[0]!.id) },
    actor,
  )
  check(
    (await banking.statements(1, filter))[0]!.reconciliation_status === 'unmatched',
    'Reconciliation can be reopened by unmatching',
  )
  const { CancelledDocumentService } = await import('../services/CancelledDocumentService')
  const draft = await purchase.create(
    1,
    purchaseInvoiceSchema.parse({
      supplier_invoice_number: 'CANCEL-ME',
      invoice_date: '2026-01-02',
      due_date: '2026-02-02',
      supplier_id: supplier,
      warehouse_id: warehouse,
      lines: [{ item_id: item, quantity: 1, unit_id: unit, unit_price: 100 }],
    }),
    actor,
  )
  await rejects(
    () => new CancelledDocumentService().remove(1, 'purchase-invoices', draft.id, actor),
    'Cannot delete a non-cancelled invoice',
  )
  await purchase.cancel(draft.id, 1, 'Cancelled for verification', actor)
  await new CancelledDocumentService().remove(1, 'purchase-invoices', draft.id, actor)
  await rejects(
    () => purchase.get(draft.id, 1),
    'Cancelled invoice deleted with FK checks and audit',
  )
  await settlements.reverse(
    1,
    false,
    first.id,
    {
      request_key: key(),
      date: '2026-12-31',
      reason: 'Remove payment after safe reversal',
    },
    actor,
  )
  await settlements.remove(1, false, first.id, actor)
  const visiblePayments = await settlements.list(1, false, { search: first.number })
  check(
    !visiblePayments.some((row) => Number(row.id) === first.id),
    'Reversed settlement can be safely removed from transaction list',
  )
  const { TaxReconciliationService } = await import('../services/TaxReconciliationService')
  const taxReconciliation = new TaxReconciliationService()
  await taxReconciliation.importInternal(
    1,
    {
      period: '2026-01',
      revision: 0,
      source_file: 'payroll.csv',
      notes: 'Payroll verification',
      rows: [
        {
          tax_type: 'pph21_employee',
          document_number: 'BP21-TEST-001',
          document_date: '2026-01-31',
          counterparty_tax_number: '0123456789012345',
          counterparty_name: 'Test Employee',
          tax_code: '21-100-01',
          dpp: 5000,
          tax_amount: 250,
          description: 'Payroll January',
        },
      ],
    },
    actor,
  )
  const autoTax: any = await taxReconciliation.overview(1, '2026-01', 'all')
  const autoDocument = autoTax.rows.find(
    (row: any) => row.source_key && !row.source_key.startsWith('INTERNAL-'),
  )
  await taxReconciliation.linkDocument(
    1,
    {
      source_key: autoDocument.source_key,
      tax_document_number: 'TAX-DOC-TEST-001',
      tax_document_date: '2026-01-31',
      notes: 'Document matching verification',
    },
    actor,
  )
  const taxBefore: any = await taxReconciliation.overview(1, '2026-01', 'all')
  const reportedRows = taxBefore.rows.map((row: any, index: number) => ({
    tax_type: row.tax_type,
    document_number: row.document_number || `SPT-TEST-${index + 1}`,
    document_date: row.document_date,
    counterparty_tax_number: row.counterparty_tax_number,
    counterparty_name: row.counterparty_name,
    tax_code: row.tax_code,
    dpp: row.system_dpp,
    tax_amount: row.system_tax,
    description: 'Snapshot SPT untuk verifikasi',
  }))
  check(
    taxBefore.groups.pph21.system_documents === 1 &&
      taxBefore.groups.unification.system_documents > 0,
    'Tax workspaces separate PPh 21 and PPh Unification documents',
  )
  check(
    taxBefore.rows.some((row: any) => row.document_number === 'TAX-DOC-TEST-001'),
    'Tax invoice or withholding receipt number can be linked to an automatic transaction',
  )
  check(
    reportedRows.length > 0,
    'Tax reconciliation reads posted VAT, withholding, and internal payroll transactions',
  )
  await taxReconciliation.importReport(
    1,
    {
      period: '2026-01',
      revision: 0,
      source_file: 'verification.csv',
      notes: 'Integration verification',
      rows: reportedRows,
    },
    actor,
  )
  const matchedTax: any = await taxReconciliation.overview(1, '2026-01', 'all')
  check(
    matchedTax.summary.exceptions === 0 && matchedTax.summary.readiness === 100,
    'SPT import matches system tax documents and reaches 100% readiness',
  )
  reportedRows[0].tax_amount = Number(reportedRows[0].tax_amount) + 10
  await taxReconciliation.importReport(
    1,
    {
      period: '2026-01',
      revision: 1,
      source_file: 'verification-revision.csv',
      notes: 'Revision verification',
      rows: reportedRows,
    },
    actor,
  )
  const mismatchedTax: any = await taxReconciliation.overview(1, '2026-01', 'all')
  const taxException = mismatchedTax.rows.find((row: any) => row.status === 'amount_mismatch')
  check(Boolean(taxException), 'Tax reconciliation flags an SPT amount difference')
  await taxReconciliation.resolve(
    1,
    {
      period: '2026-01',
      match_key: taxException.match_key,
      resolution_code: 'spt_correction',
      note: 'Akan masuk pembetulan SPT',
    },
    actor,
  )
  const resolvedTax: any = await taxReconciliation.overview(1, '2026-01', 'all')
  check(
    resolvedTax.summary.exceptions === 0 && resolvedTax.summary.resolved === 1,
    'Documented tax resolution clears the review exception',
  )
  await taxReconciliation.setStatus(1, '2026-01', 'reviewed', actor)
  await taxReconciliation.setStatus(1, '2026-01', 'locked', actor)
  await rejects(
    () =>
      taxReconciliation.importReport(
        1,
        {
          period: '2026-01',
          revision: 2,
          source_file: 'blocked.csv',
          notes: '',
          rows: reportedRows,
        },
        actor,
      ),
    'Locked tax period rejects replacement imports',
  )
  const trial = await reports.trialBalance(1, { dateFrom: '2026-01-01', dateTo: '2026-12-31' })
  check(trial.balanced && Number(trial.difference) === 0, 'All resulting journals balance')
  const [numbers] = await db.query<any[]>('SELECT journal_number FROM journals WHERE company_id=1')
  check(
    numbers.every((n) => /^JV-2026-\d{2}-\d{6}$/.test(n.journal_number)),
    'Journal numbers include year and month',
  )
  const { BackupService } = await import('../services/BackupService'),
    backupService = new BackupService()
  const backup = await backupService.create(1, 'full', actor)
  const backupFile = await backupService.file(1, backup.id)
  const backupDocument = await Bun.file(backupFile.path).json()
  check(
    backupDocument.format === 'finora-portable-backup-v1' &&
      Object.keys(backupDocument.tables).length > 20,
    'Portable full backup includes schema and data without external database tools',
  )
  await unlink(backupFile.path)
  console.log(`Completed ${checks} integration checks in isolated schema.`)
} finally {
  await db.end()
  if (!/^finora_verify_\d+_\d+$/.test(schema) || schema === originalDatabase)
    throw new Error('Unsafe test schema cleanup')
  await admin.query(`DROP DATABASE \`${schema}\``)
  await admin.end()
}
