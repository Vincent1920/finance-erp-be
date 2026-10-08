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
let testBackupPath:string|undefined
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
  await db.query('CREATE TABLE IF NOT EXISTS migrations(id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,name VARCHAR(191) NOT NULL UNIQUE,run_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB')
  for (const migration of migrations){await migration.up(db);await db.execute('INSERT INTO migrations(name) VALUES(?)',[migration.name])}
  const { seedCore } = await import('./seeds/core.seed')
  await transaction((c) => seedCore(c))
  const [users] = await db.query<any[]>('SELECT id,password FROM users ORDER BY id LIMIT 1'),
    actor = { userId: Number(users[0].id), requestId: 'operational-verify' }
  const approverId = await (async () => {
    const [result] = await db.execute<any>(
      "INSERT INTO users(company_id,name,email,password,status) VALUES(1,'Operational Approver','approver@verify.local',?,'active')",
      [users[0].password],
    )
    return Number(result.insertId)
  })()
  const approver = { userId: approverId, requestId: 'operational-verify-approver' }
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
  const { AccountMappingService } = await import('../services/AccountMappingService')
  const setupMappings=new AccountMappingService()
  for(const [key,code] of Object.entries({AR_CONTROL:'1130',AP_CONTROL:'2101',INVENTORY:'1140',COGS:'5100',REVENUE:'4100',PURCHASE_EXPENSE:'6100',INPUT_VAT:'1150',OUTPUT_VAT:'2201',WITHHOLDING_TAX:'2202'})) await setupMappings.upsert({id:actor.userId,companyId:1,roles:['super-admin']},setupMappings.assertKey(key),ids[code]!)
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
  const stressItem = await insert(
    "INSERT INTO items(company_id,sku,name,item_type,unit_id,sales_account_id,inventory_account_id,cogs_account_id,purchase_account_id,sales_price,purchase_price) VALUES(1,'STRESS-INV','Inventory valuation stress','inventory',?,?,?,?,?,1000,100)",
    [unit, ids['4100'], ids['1140'], ids['5100'], ids['6100']],
  )
  const { inventoryStress } = await import('./inventory-stress')
  const { verifyFifo } = await import('./fifo-verify')
  await verifyFifo({item:stressItem,warehouse,warehouse2,supplier,customer,unit,inventoryAccount:ids['1140']!,actor,approver})
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
  await purchase.approve(pi.id, 1, approver)
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
  await sales.approve(si.id, 1, approver)
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
    await sales.approve(created.id, 1, approver)
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
      date: '2026-01-13',
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
      invoice_date: '2026-01-13',
      due_date: '2026-02-10',
      supplier_id: supplier,
      warehouse_id: warehouse,
      lines: [{ item_id: item2, quantity: 2, unit_id: unit, unit_price: 50 }],
    }),
    actor,
  )
  await purchase.submit(pi2.id, 1, actor)
  await purchase.approve(pi2.id, 1, approver)
  await purchase.post(pi2.id, 1, actor)
  const applied = await creditService.apply(
    1,
    false,
    {
      request_key: key(),
      date: '2026-01-13',
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
    { request_key: key(), date: '2026-01-13', reason: 'Reverse credit application' },
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
      date: '2026-01-13',
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
    { request_key: key(), date: '2026-01-13', reason: 'Reverse supplier refund' },
    actor,
  )
  await returns.reverse(
    1,
    creditReturn.id,
    {
      request_key: key(),
      date: '2026-01-13',
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
  const automaticTaxRows = autoTax.rows.filter(
    (row: any) => row.source_key && !row.source_key.startsWith('INTERNAL-'),
  )
  for (const [index, row] of automaticTaxRows.entries())
    await taxReconciliation.linkDocument(
      1,
      {
        source_key: row.source_key,
        tax_document_number: `TAX-DOC-TEST-${String(index + 1).padStart(3, '0')}`,
        tax_document_date: row.document_date || '2026-01-31',
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
      revision: 0,
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
  await rejects(
    () =>
      taxReconciliation.linkDocument(
        1,
        {
          source_key: matchedTax.system_rows[0].source_key,
          tax_document_number: 'LOCK-CHANGE',
          tax_document_date: '2026-01-03',
          notes: 'Should be blocked',
        },
        actor,
      ),
    'Locked tax period rejects document relinking',
  )
  check(
    (await taxReconciliation.overview(1, '2026-01', 'all')).versions.length === 1,
    'Replacement import retains prior SPT snapshot',
  )
  await taxReconciliation.amend(
    1,
    '2026-01',
    'Correction supported by replacement documents',
    actor,
  )
  const amendment = await taxReconciliation.overview(1, '2026-01', 'all')
  check(
    amendment.period.revision === 1 &&
      amendment.imported_rows.length === 0 &&
      amendment.versions.length === 2,
    'Amendment opens a new revision without presenting old rows as new SPT',
  )
  await rejects(
    () => taxReconciliation.setStatus(1, '2026-01', 'locked', actor),
    'A new amendment cannot lock before its SPT is imported',
  )
  reportedRows[0].tax_amount = Number(reportedRows[0].tax_amount) - 10
  await taxReconciliation.importReport(
    1,
    {
      period: '2026-01',
      revision: 1,
      source_file: 'amendment.csv',
      notes: 'Corrected SPT documents',
      rows: reportedRows,
    },
    actor,
  )
  const { PostingService } = await import('../services/PostingService'),
    posting = new PostingService()
  let verificationJournalId = 0
  async function post(lines: any[], date = '2026-04-01', sourceType = 'verification') {
    return transaction((c) =>
      posting.createPostedJournal(c, {
        companyId: 1,
        sourceType,
        sourceId: ++verificationJournalId,
        date,
        description: 'Verification journal',
        lines,
        context: actor,
      }),
    )
  }
  const taxPaymentJournal = await post([
    { accountId: ids['2201'], debit: '100', credit: '0' },
    { accountId: ids['1102'], debit: '0', credit: '100' },
  ])
  const evidence = {
    period: '2026-01',
    tax_group: 'ppn' as const,
    date: '2026-04-01',
    ntpn: 'TESTNTPN00000001',
    journal_id: taxPaymentJournal,
    account_id: ids['2201']!,
    amount: 100,
    notes: 'Tax payment verification',
  }
  await taxReconciliation.payment(1, evidence, actor)
  await rejects(
    () => taxReconciliation.payment(1, evidence, actor),
    'Duplicate NTPN cannot allocate a payment twice',
  )
  await rejects(
    () => taxReconciliation.payment(1, { ...evidence, ntpn: 'TESTNTPN00000002', amount: 1 }, actor),
    'Tax evidence cannot exceed the payment journal',
  )
  await rejects(
    () =>
      taxReconciliation.payment(
        1,
        { ...evidence, tax_group: 'unification', ntpn: 'TESTNTPN00000003' },
        actor,
      ),
    'Tax payment account must match the tax group',
  )
  check(
    Number(
      (await taxReconciliation.overview(1, '2026-01', 'all')).payment_summary.ppn.linked_payment,
    ) === 100,
    'SPT-to-payment summary includes posted evidence',
  )
  await posting.reverseManual({
    companyId: 1,
    journalId: taxPaymentJournal,
    date: '2026-04-02',
    reason: 'Invalid payment correction',
    context: actor,
  })
  check(
    Number(
      (await taxReconciliation.overview(1, '2026-01', 'all')).payment_summary.ppn.linked_payment,
    ) === 0,
    'Reversed payment evidence is excluded from paid totals',
  )
  const foreignAccount = await insert(
    "INSERT INTO accounts(company_id,code,name,account_type,normal_balance,is_posting,is_header,is_active) VALUES(1,'1104','USD Bank','asset','debit',1,0,1)",
  )
  const gain = await insert(
    "INSERT INTO accounts(company_id,code,name,account_type,normal_balance,is_posting,is_header,is_active) VALUES(1,'7101','FX Gain','other_income','credit',1,0,1)",
  )
  const loss = await insert(
    "INSERT INTO accounts(company_id,code,name,account_type,normal_balance,is_posting,is_header,is_active) VALUES(1,'8101','FX Loss','other_expense','debit',1,0,1)",
  )
  await db.execute(
    "INSERT INTO account_mappings(company_id,mapping_key,account_id) VALUES(1,'FX_GAIN',?),(1,'FX_LOSS',?)",
    [gain, loss],
  )
  const usdBank = await insert(
    "INSERT INTO bank_accounts(company_id,code,bank_name,account_number,account_name,currency,gl_account_id,created_by) VALUES(1,'USD','USD Bank','456','Test USD','USD',?,?)",
    [foreignAccount, actor.userId],
  )
  await rejects(()=>post([{accountId:foreignAccount,debit:'15000',credit:'0'},{accountId:ids['3100'],debit:'0',credit:'15000'}]),'Direct foreign bank posting without native currency details is rejected')
  await post(
    [
      { accountId: ids['1102'], debit: '50000000', credit: '0' },
      { accountId: ids['3100'], debit: '0', credit: '50000000' },
    ],
    '2026-04-03',
  )
  const { CurrencyService } = await import('../services/CurrencyService'),
    currency = new CurrencyService()
  const fxTransfer = {
    request_key: key(),
    date: '2026-04-04',
    from_bank_id: bank,
    to_bank_id: usdBank,
    from_amount: '15000000',
    to_amount: '1000',
    target_rate: 15000,
    fee_amount: '0',
    reference: 'FX-TRANSFER',
  }
  const transfer = await currency.transfer(1, fxTransfer, actor)
  check(
    (await currency.transfer(1, fxTransfer, actor)).id === transfer.id,
    'FX transfer retry returns the same journal',
  )
  const before = await currency.overview(1, '2026-04-04'),
    position = before.banks.find((b: any) => b.id === usdBank)!
  check(
    Number(position.native_balance) === 1000 && Number(position.base_balance) === 15000000,
    'FX bank separates native USD and carrying rupiah balances',
  )
  const valuation = {
    request_key: key(),
    date: '2026-04-05',
    bank_id: usdBank,
    rate: 16000,
    reference: 'CLOSING-RATE',
  }
  const preview = await currency.revalue(1, valuation, actor, true)
  check(
    Number(preview.difference) === 1000000,
    'Revaluation preview computes unrealized exchange gain',
  )
  await currency.revalue(1, valuation, actor)
  const usdBook = await banking.cash(1, {
    date_from: '2026-04-01',
    date_to: '2026-04-05',
    bank_account_id: usdBank,
  })
  check(
    Number(usdBook.summary.closing) === 1000 && Number(usdBook.summary.inflow) === 1000,
    'Native bank cash book does not count revaluation as cash',
  )
  await rejects(
    () => currency.revalue(1, { ...valuation, request_key: key() }, actor),
    'Repeated valuation at the same rate cannot double-post a gain',
  )
  await rejects(
    () => currency.transfer(1, { ...fxTransfer, request_key: key(), date: '2026-04-04' }, actor),
    'Backdated foreign transfer is blocked after a later valuation',
  )
  const [operations] = await db.query<any[]>(
    'SELECT id,journal_id FROM currency_bank_operations ORDER BY id DESC LIMIT 1',
  )
  await rejects(
    () =>
      posting.reverseManual({
        companyId: 1,
        journalId: operations[0].journal_id,
        date: '2026-04-05',
        reason: 'Must use source module',
        context: actor,
      }),
    'Generic journal reversal cannot bypass FX bank controls',
  )
  await currency.reverse(
    1,
    operations[0].id,
    { request_key: key(), date: '2026-04-05', reason: 'Reverse closing valuation' },
    actor,
  )
  check(
    Number(
      (await currency.overview(1, '2026-04-05')).banks.find((b: any) => b.id === usdBank)!
        .base_balance,
    ) === 15000000,
    'Source reversal restores foreign carrying value',
  )
  const usdCustomer = await insert(
    "INSERT INTO customers(company_id,code,name,currency,tax_number,receivable_account_id) VALUES(1,'USD-CUSTOMER','USD Customer','USD','0123456789012345',?)",
    [ids['1130']],
  )
  await db.execute('UPDATE items SET sales_account_id=? WHERE id=?', [ids['4100'], shippingItem])
  const usdInvoice = await sales.create(
    1,
    salesInvoiceSchema.parse({
      invoice_date: '2026-04-06',
      due_date: '2026-05-06',
      customer_id: usdCustomer,
      currency: 'USD',
      exchange_rate: 15000,
      lines: [
        {
          item_id: shippingItem,
          quantity: 1,
          unit_id: unit,
          unit_price: 100,
          sales_account_id: ids['4100'],
        },
      ],
    }),
    actor,
  )
  await sales.submit(usdInvoice.id, 1, actor)
  await sales.approve(usdInvoice.id, 1, approver)
  await sales.post(usdInvoice.id, 1, actor)
  const { settlementSchema } = await import('../validators/operations.validator')
  const fxPayment = await settlements.post(
    1,
    true,
    settlementSchema.parse({
      request_key: key(),
      date: '2026-04-07',
      bank_account_id: usdBank,
      cash_account_id: foreignAccount,
      exchange_rate: 16000,
      payment_method: 'bank_transfer',
      allocations: [{ invoice_id: usdInvoice.id, amount: '100' }],
    }),
    actor,
  )
  const [fxRows] = await db.execute<any[]>('SELECT fx_amount FROM customer_payments WHERE id=?', [
    fxPayment.id,
  ])
  check(
    Number(fxRows[0].fx_amount) === 100000,
    'Foreign invoice settlement recognizes the difference from its historical rate',
  )
  const [paidFx] = await db.execute<any[]>(
    'SELECT outstanding_amount FROM sales_invoices WHERE id=?',
    [usdInvoice.id],
  )
  check(
    Number(paidFx[0].outstanding_amount) === 0,
    'FX gain does not change the invoice allocation amount',
  )
  await banking.create(
    1,
    {
      request_key: key(),
      bank_account_id: usdBank,
      number: 'USD-STATEMENT',
      date_from: '2026-04-04',
      date_to: '2026-04-07',
      opening_balance: 0,
      closing_balance: 1100,
      lines: [
        {
          date: '2026-04-04',
          description: 'Currency transfer',
          reference: 'FX-TRANSFER',
          debit: '0',
          credit: '1000',
          balance: 1000,
        },
        {
          date: '2026-04-07',
          description: 'Customer receipt',
          reference: fxPayment.number,
          debit: '0',
          credit: '100',
          balance: 1100,
        },
      ],
    },
    actor,
  )
  const nativeSuggestions = await banking.suggestions(1, {
    bank_account_id: usdBank,
    date_from: '2026-04-04',
    date_to: '2026-04-07',
  })
  check(
    nativeSuggestions.length === 2,
    'Foreign bank suggestions compare USD statement movements against native journal amounts',
  )
  for (const suggestion of nativeSuggestions as any[])
    await banking.match(
      1,
      {
        request_key: key(),
        statement_line_id: Number(suggestion.statement_line_id),
        journal_line_id: Number(suggestion.journal_line_id),
      },
      actor,
    )
  const [nativeRecon] = await db.query<any[]>(
    'SELECT difference,status FROM bank_reconciliations WHERE bank_account_id=?',
    [usdBank],
  )
  check(
    Number(nativeRecon[0].difference) === 0 && nativeRecon[0].status === 'completed',
    'Foreign bank reconciliation completes without treating revaluation as cash',
  )
  const nativeControls = await reports.subledger(1, '2026-04-07')
  const nativeControl = nativeControls.find((r) => r.accountId === foreignAccount)!
  check(
    Number(nativeControl.generalLedger) === 16600000 &&
      Number(nativeControl.subledger) === 16600000,
    'Foreign bank control report compares bank evidence and GL in the same base currency',
  )
  const usdSupplier = await insert(
    "INSERT INTO suppliers(company_id,code,name,currency,tax_number,payable_account_id) VALUES(1,'USD-SUPPLIER','USD Supplier','USD','0123456789012345',?)",
    [ids['2101']],
  )
  const usdPurchase = await purchase.create(
    1,
    purchaseInvoiceSchema.parse({
      supplier_invoice_number: 'USD-PI',
      invoice_date: '2026-04-08',
      due_date: '2026-05-08',
      supplier_id: usdSupplier,
      currency: 'USD',
      exchange_rate: 15000,
      lines: [{ item_id: shippingItem, quantity: 1, unit_id: unit, unit_price: 100 }],
    }),
    actor,
  )
  await purchase.submit(usdPurchase.id, 1, actor)
  await purchase.approve(usdPurchase.id, 1, approver)
  await purchase.post(usdPurchase.id, 1, actor)
  const usdPayout = await settlements.post(
    1,
    false,
    settlementSchema.parse({
      request_key: key(),
      date: '2026-04-09',
      bank_account_id: usdBank,
      cash_account_id: foreignAccount,
      exchange_rate: 17000,
      allocations: [{ invoice_id: usdPurchase.id, amount: '100' }],
    }),
    actor,
  )
  const afterPayout = await currency.overview(1, '2026-04-09'),
    cashAfter = afterPayout.banks.find((b: any) => b.id === usdBank)!
  check(
    Number(cashAfter.native_balance) === 1000 && Number(cashAfter.base_balance) === 15090909.09,
    'Foreign purchase payment removes cash at its carrying value and preserves the residual balance',
  )
  await settlements.reverse(
    1,
    false,
    usdPayout.id,
    { request_key: key(), date: '2026-04-09', reason: 'Reverse USD supplier payment' },
    actor,
  )
  check(
    Number(
      (await currency.overview(1, '2026-04-09')).banks.find((b: any) => b.id === usdBank)!
        .base_balance,
    ) === 16600000,
    'Foreign payment reversal restores both cash currencies',
  )
  const usdBasePartial=await settlements.post(1,false,settlementSchema.parse({request_key:key(),invoice_id:usdPurchase.id,date:'2026-04-10',amount:30,bank_account_id:bank,cash_account_id:ids['1102'],exchange_rate:16000}),actor)
  const partialDetail:any=await purchase.get(usdPurchase.id,1)
  check(Number(partialDetail.outstanding_amount)===70 && partialDetail.status==='partially_paid','USD purchase partial payment from IDR bank preserves native outstanding')
  const usdBaseFinal=await settlements.post(1,false,settlementSchema.parse({request_key:key(),invoice_id:usdPurchase.id,date:'2026-04-11',amount:70,bank_account_id:bank,cash_account_id:ids['1102'],exchange_rate:14000,processing_fee_amount:2,processing_fee_account_id:ids['6100']}),actor)
  const finalDetail:any=await purchase.get(usdPurchase.id,1)
  check(Number(finalDetail.outstanding_amount)===0 && finalDetail.status==='paid','USD purchase final IDR settlement closes native outstanding')
  const [usdBasePayments]=await db.execute<any[]>('SELECT bank_currency,bank_amount,carrying_base_amount,fx_amount FROM supplier_payments WHERE id IN (?,?) ORDER BY id',[usdBasePartial.id,usdBaseFinal.id])
  check(usdBasePayments[0].bank_currency==='IDR' && Number(usdBasePayments[0].bank_amount)===480000 && Number(usdBasePayments[0].carrying_base_amount)===450000 && Number(usdBasePayments[0].fx_amount)===30000,'USD partial payment posts 450000 AP, 480000 IDR bank, and 30000 FX loss')
  check(Number(usdBasePayments[1].bank_amount)===1008000 && Number(usdBasePayments[1].carrying_base_amount)===1050000 && Number(usdBasePayments[1].fx_amount)===-70000,'USD final payment converts fee and posts 70000 FX gain without mixing bank currency')
  const [usdPaymentBalances]=await db.execute<any[]>('SELECT j.id,SUM(l.debit-l.credit) difference FROM journals j JOIN journal_lines l ON l.journal_id=j.id WHERE j.id IN (?,?) GROUP BY j.id',[usdBasePartial.journalId,usdBaseFinal.journalId])
  check(usdPaymentBalances.every(r=>Number(r.difference)===0),'Both IDR settlements of USD purchase generate balanced journals')
  const listedUsdPayments=await settlements.list(1,false,{invoiceId:usdPurchase.id})
  check(listedUsdPayments.some(p=>p.currency==='USD'&&p.bank_currency==='IDR'),'Payment history exposes invoice USD and bank IDR as separate currencies')
  await settlements.reverse(1,false,usdBaseFinal.id,{request_key:key(),date:'2026-04-11',reason:'Verify IDR settlement reversal'},actor)
  check(Number((await purchase.get(usdPurchase.id,1) as any).outstanding_amount)===70,'IDR settlement reversal restores USD payable outstanding')
  await rejects(()=>settlements.post(1,false,settlementSchema.parse({request_key:key(),invoice_id:usdPurchase.id,date:'2026-04-12',amount:71,bank_account_id:bank,cash_account_id:ids['1102'],exchange_rate:16000}),actor),'USD overpayment is rejected atomically')
  await rejects(()=>settlements.post(1,false,settlementSchema.parse({request_key:key(),invoice_id:usdPurchase.id,date:'2026-04-12',amount:70,bank_account_id:bank,cash_account_id:ids['1102']}),actor),'USD settlement without payment rate is rejected')
  const usdStockItem=await insert("INSERT INTO items(company_id,sku,name,item_type,unit_id,inventory_account_id,purchase_account_id,cogs_account_id,sales_account_id) VALUES(1,'USD-STOCK','USD valuation item','inventory',?,?,?,?,?)",[unit,ids['1140'],ids['6100'],ids['5100'],ids['4100']])
  const usdStockPurchase=await purchase.create(1,purchaseInvoiceSchema.parse({supplier_invoice_number:'USD-STOCK-PI',invoice_date:'2026-04-12',due_date:'2026-05-12',supplier_id:supplier,warehouse_id:warehouse,currency:'USD',exchange_rate:16000,lines:[{item_id:usdStockItem,quantity:10,unit_id:unit,unit_price:10}]}),actor)
  await purchase.submit(usdStockPurchase.id,1,actor);await purchase.approve(usdStockPurchase.id,1,approver);await purchase.post(usdStockPurchase.id,1,actor)
  const [usdStock]=await db.execute<any[]>('SELECT quantity,total_value FROM inventory_balances WHERE company_id=1 AND item_id=? AND warehouse_id=?',[usdStockItem,warehouse])
  check(Number(usdStock[0].quantity)===10 && Number(usdStock[0].total_value)===1600000,'USD inventory purchase from a default-IDR supplier capitalizes base value correctly')
  await rejects(()=>settlements.post(1,false,settlementSchema.parse({request_key:key(),date:'2026-04-13',allocations:[{invoice_id:usdPurchase.id,amount:70},{invoice_id:usdStockPurchase.id,amount:100}],bank_account_id:bank,cash_account_id:ids['1102'],exchange_rate:16500}),actor),'USD allocation across different suppliers is rejected')
  const createUsdService=async(number:string,amount:number,rate:number,date:string)=>{
    const invoice=await purchase.create(1,purchaseInvoiceSchema.parse({supplier_invoice_number:number,invoice_date:date,due_date:'2026-05-30',supplier_id:usdSupplier,currency:'USD',exchange_rate:rate,lines:[{item_id:shippingItem,quantity:1,unit_id:unit,unit_price:amount}]}),actor)
    await purchase.submit(invoice.id,1,actor);await purchase.approve(invoice.id,1,approver);await purchase.post(invoice.id,1,actor);return invoice
  }
  const batchUsdInvoice=await createUsdService('USD-BATCH-PI',20,17000,'2026-04-12')
  const multiUsdInput=settlementSchema.parse({request_key:key(),date:'2026-04-13',allocations:[{invoice_id:usdPurchase.id,amount:70},{invoice_id:batchUsdInvoice.id,amount:20}],bank_account_id:bank,cash_account_id:ids['1102'],exchange_rate:16500})
  const multiUsd=await settlements.post(1,false,multiUsdInput,actor)
  check((await settlements.post(1,false,multiUsdInput,actor)).id===multiUsd.id,'USD multi-invoice payment retry is idempotent')
  const [multiUsdPayment]=await db.execute<any[]>('SELECT amount,bank_amount,carrying_base_amount,fx_amount FROM supplier_payments WHERE id=?',[multiUsd.id])
  check(Number(multiUsdPayment[0].amount)===90 && Number(multiUsdPayment[0].bank_amount)===1485000 && Number(multiUsdPayment[0].carrying_base_amount)===1390000 && Number(multiUsdPayment[0].fx_amount)===95000,'Multiple USD invoices with different historical rates settle at their own carrying amounts')
  check((await purchase.get(usdPurchase.id,1) as any).status==='paid' && (await purchase.get(batchUsdInvoice.id,1) as any).status==='paid','USD batch payment closes all selected invoices')
  const roundingUsd=await createUsdService('USD-ROUNDING-PI',0.03,16000.5,'2026-04-14')
  for(const date of ['2026-04-15','2026-04-16','2026-04-17'])await settlements.post(1,false,settlementSchema.parse({request_key:key(),invoice_id:roundingUsd.id,date,amount:0.01,bank_account_id:bank,cash_account_id:ids['1102'],exchange_rate:16000.5}),actor)
  const [roundedAllocations]=await db.execute<any[]>('SELECT SUM(a.base_amount) total FROM supplier_payment_allocations a JOIN supplier_payments p ON p.id=a.supplier_payment_id WHERE a.purchase_invoice_id=? AND p.status=\'posted\'',[roundingUsd.id])
  check(Number(roundedAllocations[0].total)===480.02 && Number((await purchase.get(roundingUsd.id,1) as any).outstanding_amount)===0,'Final USD partial payment absorbs rounding residue and exactly clears base AP')
  const { AccountingScheduleService } = await import('../services/AccountingScheduleService'),
    schedules = new AccountingScheduleService()
  const { accountingScheduleSchema } = await import('../validators/accounting-schedule.validator')
  const schedule = await schedules.create(
    1,
    accountingScheduleSchema.parse({
      schedule_type: 'accrual',
      name: 'Accrual verification',
      start_date: '2026-05-31',
      periods_count: 1,
      total_estimated_amount: 1000,
      pnl_account_id: ids['6100'],
      balance_sheet_account_id: ids['2202'],
      auto_reverse: false,
      auto_submit: false,
    }),
    actor,
  )
  const scheduleDetail: any = (await schedules.overview(1)).find((s: any) => s.id === schedule.id),
    entryId = Number(scheduleDetail.entries[0].id)
  const generated = await schedules.generate(1, entryId, actor)
  const { JournalService } = await import('../services/JournalService'),
    journalService = new JournalService()
  await journalService.submit(generated.journalId, 1, actor)
  await journalService.approve(generated.journalId, 1, approver)
  await journalService.post(generated.journalId, 1, actor)
  await schedules.reconcile(1, entryId, { actual_amount: 1050, source_mode: 'observation' }, actor)
  check(
    !(await schedules.overview(1)).find((s: any) => s.id === schedule.id)!.entries[0]!
      .actual_verified,
    'Observed actual amounts do not claim journal verification',
  )
  const correction = { date: '2026-06-01', actual_amount: 1050, reference: 'ACTUAL-VERIFICATION' }
  const draftCorrection = await schedules.adjustment(1, entryId, correction, actor)
  check(
    (await schedules.adjustment(1, entryId, correction, actor)).journalId ===
      draftCorrection.journalId,
    'Identical correction requests reuse the same draft',
  )
  await rejects(
    () => schedules.adjustment(1, entryId, { ...correction, actual_amount: 1100 }, actor),
    'A different actual correction cannot silently duplicate an existing draft',
  )
  const actualJournal = draftCorrection.journalId
  await journalService.submit(actualJournal, 1, actor)
  await journalService.approve(actualJournal, 1, approver)
  await journalService.post(actualJournal, 1, actor)
  const [actualLines] = await db.execute<any[]>(
    'SELECT id FROM journal_lines WHERE journal_id=? AND account_id=?',
    [actualJournal, ids['6100']],
  )
  await rejects(
    () =>
      schedules.reconcile(
        1,
        entryId,
        {
          actual_amount: 1100,
          actual_line_id: actualLines[0].id,
          source_mode: 'variance_adjustment',
        },
        actor,
      ),
    'Actual comparison rejects a correction journal with the wrong variance',
  )
  await schedules.reconcile(
    1,
    entryId,
    { actual_amount: 1050, actual_line_id: actualLines[0].id, source_mode: 'variance_adjustment' },
    actor,
  )
  check(
    (await schedules.overview(1)).find((s: any) => s.id === schedule.id)!.entries[0]!
      .actual_verified,
    'Actual variance is verified against a posted expense line and its counterpart',
  )
  await posting.reverseManual({
    companyId: 1,
    journalId: actualJournal,
    date: '2026-06-02',
    reason: 'Reverse actual evidence',
    context: actor,
  })
  check(
    !(await schedules.overview(1)).find((s: any) => s.id === schedule.id)!.entries[0]!
      .actual_verified,
    'Reversed actual journals invalidate verification',
  )
  const reversing = await schedules.create(
    1,
    accountingScheduleSchema.parse({
      schedule_type: 'accrual',
      name: 'Reversing accrual',
      start_date: '2026-07-31',
      periods_count: 1,
      total_estimated_amount: 1000,
      pnl_account_id: ids['6100'],
      balance_sheet_account_id: ids['2202'],
      auto_reverse: true,
      auto_submit: false,
    }),
    actor,
  )
  const reversingEntry: any = (await schedules.overview(1)).find((s: any) => s.id === reversing.id)!
    .entries[0]
  const reversingRecognition = await schedules.generate(1, reversingEntry.id, actor)
  await journalService.submit(reversingRecognition.journalId, 1, actor)
  await journalService.approve(reversingRecognition.journalId, 1, approver)
  await journalService.post(reversingRecognition.journalId, 1, actor)
  const actualFull = await post(
    [
      { accountId: ids['6100'], debit: '1050', credit: '0' },
      { accountId: ids['2202'], debit: '0', credit: '1050' },
    ],
    '2026-08-01',
  )
  const [fullLines] = await db.query<any[]>(
    'SELECT id FROM journal_lines WHERE journal_id=? AND account_id=?',
    [actualFull, ids['6100']],
  )
  const actualFullInput = {
    actual_amount: 1050,
    actual_line_id: fullLines[0].id,
    source_mode: 'expense_after_reversal' as const,
  }
  await rejects(
    () => schedules.reconcile(1, reversingEntry.id, actualFullInput, actor),
    'Full actual expense cannot verify while its estimate is still unreversed',
  )
  const reversingJournal = await schedules.reverse(1, reversingEntry.id, actor)
  await journalService.submit(reversingJournal.journalId, 1, actor)
  await journalService.approve(reversingJournal.journalId, 1, approver)
  await journalService.post(reversingJournal.journalId, 1, actor)
  await schedules.reconcile(1, reversingEntry.id, actualFullInput, actor)
  check(
    (await schedules.overview(1)).find((s: any) => s.id === reversing.id)!.entries[0]!
      .actual_verified,
    'Full actual expense verifies after the accrual reversal is posted',
  )
  await inventoryStress({item: stressItem, warehouse, supplier, customer, unit, inventoryAccount: ids['1140']!, actor, approver})
  const trial = await reports.trialBalance(1, { dateFrom: '2026-01-01', dateTo: '2026-12-31' })
  check(trial.balanced && Number(trial.difference) === 0, 'All resulting journals balance')
  const { AccountingControlService } = await import('../services/AccountingControlService')
  const controls = new AccountingControlService()
  const initialControls = await controls.overview(1, '2026-12-31')
  check(initialControls.checks.find(c=>c.code==='trial_balance')?.status==='passed', 'Control center verifies trial balance from posted data')
  check(initialControls.checks.find(c=>c.code==='profit_link')?.status==='passed', 'Control center links fiscal profit to balance sheet earnings')
  const [controlJournals] = await db.query<any[]>("SELECT id FROM journals WHERE company_id=1 AND status='posted' LIMIT 1")
  const controlJournalId=controlJournals[0].id
  await db.execute('UPDATE journals SET total_debit=total_debit+1 WHERE id=?',[controlJournalId])
  const corruptControls=await controls.overview(1,'2026-12-31')
  check(corruptControls.checks.find(c=>c.code==='journal_lines')?.status==='failed','Control center detects header totals inconsistent with journal lines')
  await db.execute('UPDATE journals SET total_debit=total_debit-1 WHERE id=?',[controlJournalId])
  const otherCompanyControls=await controls.overview(999999,'2026-12-31')
  check(otherCompanyControls.reconciliations.length===0,'Control center does not expose another company balances')
  const [numbers] = await db.query<any[]>('SELECT journal_number FROM journals WHERE company_id=1')
  check(
    numbers.every((n) => /^JV-2026-\d{2}-\d{6}$/.test(n.journal_number)),
    'Journal numbers include year and month',
  )
  const { BackupService } = await import('../services/BackupService'),
    { PrintTemplateService } = await import('../services/PrintTemplateService'),
    backupService = new BackupService()
  const printTemplates=new PrintTemplateService()
  const oldTemplate=await printTemplates.get(1,'sales_invoice')
  await printTemplates.save(1,'sales_invoice',{...oldTemplate.template,headerTitle:'Invoice internal',marginTopMm:20,columnWidths:{name:40}},actor,{templateId:'internal',templateName:'Internal',setDefault:false,templateVersion:0})
  check((await printTemplates.get(1,'sales_invoice')).templateId==='default','Saving an alternate print template preserves the existing print default')
  const alternate=await printTemplates.get(1,'sales_invoice','internal')
  check(alternate.template.marginTopMm===20 && Number((alternate.template.columnWidths as any).name)===40,'Named print template retains independent margins and column widths')
  await printTemplates.save(1,'sales_invoice',alternate.template,actor,{templateId:'internal',templateName:'Internal',setDefault:true,templateVersion:1})
  check((await printTemplates.get(1,'sales_invoice')).templateId==='internal','Print output resolves the selected default template')
  await rejects(()=>printTemplates.save(1,'sales_invoice',alternate.template,actor,{templateId:'internal',templateName:'Stale',setDefault:true,templateVersion:1}),'Stale print template version cannot overwrite a concurrent edit')
  await rejects(()=>printTemplates.get(999999,'sales_invoice','internal'),'Named print templates remain isolated by company')
  const { verifyCoaGovernance } = await import('./coa-governance-verify')
  await verifyCoaGovernance(actor.userId,approverId,ids['4100']!)
  const { CurrencyService: CurrencyOptionsService } = await import('../services/CurrencyService')
  const currencyOptionsService = new CurrencyOptionsService()
  const currencyOptions = await currencyOptionsService.options(1)
  check(currencyOptions.currencies.some(currency => currency.code === 'IDR') && currencyOptions.currencies.some(currency => currency.code === 'USD'),'Currency options include IDR bookkeeping currency alongside USD')
  check((await currencyOptionsService.quote(1,'IDR','2026-10-04')).rate === '1','IDR bookkeeping exchange rate is always one')
  await db.execute("UPDATE currencies SET is_active=FALSE WHERE code='IDR'")
  check((await currencyOptionsService.options(1)).currencies.some(currency => currency.code === 'IDR'),'Bookkeeping currency stays available when its catalog record is inactive')
  await db.execute("UPDATE currencies SET is_active=TRUE WHERE code='IDR'")
  const departmentService = new (await import('../services/EntityService')).EntityService('departments')
  const department = await departmentService.create(1,{code:'DEP-VERIFY',name:'Department verifier',is_active:true},actor)
  const departmentId = Number(department.id)
  await db.execute("INSERT INTO payroll_employees(company_id,employee_number,name,hire_date,ptkp_status,ter_category,basic_salary,fixed_allowance,created_by,is_active) VALUES(1,'DEP-EMP','Department employee','2027-01-01','TK/0','A',0,0,?,FALSE)",[actor.userId])
  const [employeeRows] = await db.query<any[]>("SELECT * FROM payroll_employees WHERE company_id=1 AND employee_number='DEP-EMP'")
  check(employeeRows.length > 0,'Department integration has an existing payroll employee')
  const employee = employeeRows[0]
  const payrollDepartmentService = new (await import('../services/PayrollService')).PayrollService()
  await payrollDepartmentService.saveEmployee(1,employee.id,{...employee,is_active:Boolean(employee.is_active),department_id:departmentId},actor)
  await departmentService.update(departmentId,1,{name:'Renamed verifier'},actor)
  const [assigned] = await db.query<any[]>('SELECT department,department_id FROM payroll_employees WHERE id=?',[employee.id])
  check(assigned[0].department==='Renamed verifier' && Number(assigned[0].department_id)===departmentId,'Department rename preserves employee relationship and updates display name')
  check(await departmentService.remove(departmentId,1,actor)==='deactivated','Used departments are deactivated instead of physically deleted')
  await rejects(()=>payrollDepartmentService.saveEmployee(1,null,{...employee,employee_number:'DEP-NEW',department_id:departmentId},actor),'Inactive departments cannot be assigned to new employees')
  await rejects(()=>payrollDepartmentService.saveEmployee(1,employee.id,{...employee,department_id:999999999},actor),'Invalid department assignment is rejected')
  await departmentService.update(departmentId,1,{is_active:false},actor)
  await payrollDepartmentService.saveEmployee(1,employee.id,{...employee,is_active:false,department_id:departmentId},actor)
  check((await departmentService.get(departmentId,1)).is_active===0,'Existing employees retain their inactive department')
  await rejects(()=>departmentService.get(departmentId,999999),'Departments are isolated by company')
  const { verifyUserAccess } = await import('./user-access-verify')
  await verifyUserAccess(actor.userId)
  await (await import('./platform-operations-verify')).verifyPlatformOperations(actor.userId)
  const { verifyPayrollComponents } = await import('./payroll-components-verify')
  await verifyPayrollComponents(actor.userId,approverId,ids)
  const { verifyScale } = await import('./scale-verify')
  await verifyScale(actor.userId,bank)
  await (await import('./security-boundary-verify')).verifySecurityBoundary(actor.userId)
  // Automation is retired; manual component lifecycle is verified above.
  const backup = await backupService.create(1, 'full', actor)
  const backupFile = await backupService.file(1, backup.id)
  testBackupPath=backupFile.path
  const backupDocument = await Bun.file(backupFile.path).json()
  check(
    backupDocument.format === 'finora-portable-backup-v1' &&
      Object.keys(backupDocument.tables).length > 20,
    'Portable full backup includes schema and data without external database tools',
  )
  const snapshotTotals=async()=>{
    const [j]=await db.query<any[]>('SELECT COUNT(*) count FROM journals')
    const [l]=await db.query<any[]>('SELECT SUM(debit) debit,SUM(credit) credit,COUNT(*) count FROM journal_lines')
    const [stock]=await db.query<any[]>('SELECT SUM(quantity) quantity,SUM(total_value) value FROM inventory_balances')
    return {journals:j[0],lines:l[0],stock:stock[0]}
  }
  const baseline=await snapshotTotals()
  const {ReportingService:RestoreReportingService}=await import('../services/ReportingService')
  const beforeReconciliation=await new RestoreReportingService().subledger(1,'2026-12-31')
  const [binaryBefore]=await db.query<any[]>("SELECT id,SHA2(output,256) digest FROM report_exports WHERE output IS NOT NULL ORDER BY id")
  const originalContent=await Bun.file(backupFile.path).text()
  await Bun.write(backupFile.path,originalContent+'tampered')
  await rejects(()=>backupService.restore(1,backup.id,'RESTORE '+backup.number,actor),'Restore rejects changed backup checksum before altering data')
  await Bun.write(backupFile.path,originalContent)
  await db.execute('UPDATE inventory_balances SET total_value=total_value+1 WHERE id=(SELECT id FROM (SELECT MIN(id) id FROM inventory_balances) t)')
  await backupService.restore(1,backup.id,'RESTORE '+backup.number,actor)
  assert.deepEqual(await snapshotTotals(),baseline)
  assert.deepEqual(await new RestoreReportingService().subledger(1,'2026-12-31'),beforeReconciliation)
  const [binaryAfter]=await db.query<any[]>("SELECT id,SHA2(output,256) digest FROM report_exports WHERE output IS NOT NULL ORDER BY id");assert.deepEqual(binaryAfter,binaryBefore)
  const [liveSessions]=await db.query<any[]>('SELECT COUNT(*) n FROM auth_sessions WHERE revoked_at IS NULL')
  check(Number(liveSessions[0].n)===0,'Restore revokes all previous sessions')
  check(true,'Full restore reproduces journal counts, debit-credit totals and inventory balances in disposable schema')
  await unlink(backupFile.path)
  testBackupPath=undefined
  console.log(`Completed ${checks} integration checks in isolated schema.`)
} finally {
  if(testBackupPath)await unlink(testBackupPath).catch(()=>undefined)
  await db.end()
  if (!/^finora_verify_\d+_\d+$/.test(schema) || schema === originalDatabase)
    throw new Error('Unsafe test schema cleanup')
  await admin.query(`DROP DATABASE \`${schema}\``)
  await admin.end()
}
