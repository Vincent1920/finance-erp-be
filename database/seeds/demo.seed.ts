import type { RowDataPacket } from 'mysql2/promise'
import { db, transaction } from '../../config/database'
import { GoodsReceiptService } from '../../services/GoodsReceiptService'
import { BankStatementService } from '../../services/BankStatementService'
import { JournalService } from '../../services/JournalService'
import { OpeningBalanceService } from '../../services/OpeningBalanceService'
import { PurchaseInvoiceService } from '../../services/PurchaseInvoiceService'
import { PurchaseOrderService } from '../../services/PurchaseOrderService'
import { SalesInvoiceService } from '../../services/SalesInvoiceService'
import { SalesOrderService } from '../../services/SalesOrderService'
import { SalesReturnService } from '../../services/SalesReturnService'
import { hashPassword } from '../../utils/password'
import { goodsReceiptSchema } from '../../validators/goods-receipt.validator'
import { journalSchema } from '../../validators/journal.validator'
import { purchaseInvoiceSchema } from '../../validators/purchase-invoice.validator'
import { purchaseOrderSchema } from '../../validators/purchase-order.validator'
import { salesInvoiceSchema } from '../../validators/sales-invoice.validator'
import { salesOrderSchema } from '../../validators/sales.validator'
import { salesReturnSchema } from '../../validators/sales-return.validator'
import type { SeedConnection } from './types'

const COMPANY_ID = 1
const DEMO_EMAIL = 'demo.admin@finora.local'
const DEMO_PASSWORD = 'DemoFinance2026!'
const actor = { userId: 0, requestId: 'demo-seed', ip: '127.0.0.1' }

type Lookup = Record<string, number>
type StateRow = RowDataPacket & { id: number; status: string }

const accounts = [
  ['1101', 'Cash', 'asset', 'debit', 'operating'],
  ['1102', 'Bank BCA', 'asset', 'debit', 'operating'],
  ['1103', 'Bank Mandiri', 'asset', 'debit', 'operating'],
  ['1130', 'Accounts Receivable', 'asset', 'debit', 'operating'],
  ['1140', 'Inventory', 'asset', 'debit', 'operating'],
  ['1150', 'Input VAT', 'asset', 'debit', 'operating'],
  ['1201', 'Office Equipment', 'asset', 'debit', 'investing'],
  ['1202', 'Accumulated Depreciation', 'asset', 'credit', 'non_cash'],
  ['2101', 'Accounts Payable', 'liability', 'credit', 'operating'],
  ['2111', 'Goods Received Not Invoiced', 'liability', 'credit', 'operating'],
  ['2201', 'Output VAT', 'liability', 'credit', 'operating'],
  ['3101', 'Owner Capital', 'equity', 'credit', 'financing'],
  ['4101', 'Product Sales', 'revenue', 'credit', 'operating'],
  ['4102', 'Service Revenue', 'revenue', 'credit', 'operating'],
  ['5101', 'Cost of Goods Sold', 'cogs', 'debit', 'operating'],
  ['6101', 'Salary Expense', 'expense', 'debit', 'operating'],
  ['6102', 'Rent Expense', 'expense', 'debit', 'operating'],
  ['6103', 'Electricity Expense', 'expense', 'debit', 'operating'],
  ['6104', 'Internet Expense', 'expense', 'debit', 'operating'],
  ['6105', 'Office Supplies Expense', 'expense', 'debit', 'operating'],
  ['6106', 'Transportation Expense', 'expense', 'debit', 'operating'],
  ['6107', 'Depreciation Expense', 'expense', 'debit', 'non_cash'],
  ['6108', 'Professional Service Expense', 'expense', 'debit', 'operating'],
  ['7101', 'Interest Income', 'other_income', 'credit', 'operating'],
  ['8101', 'Bank Administration Expense', 'other_expense', 'debit', 'operating'],
] as const

const itemData = [
  ['ITEM-DEMO-001', 'Laptop Office 14 Inch', 'inventory', 'UNIT', 7_000_000, 8_500_000],
  ['ITEM-DEMO-002', 'Monitor 24 Inch', 'inventory', 'UNIT', 1_500_000, 2_000_000],
  ['ITEM-DEMO-003', 'Keyboard Mechanical', 'inventory', 'PCS', 450_000, 650_000],
  ['ITEM-DEMO-004', 'Wireless Mouse', 'inventory', 'PCS', 180_000, 275_000],
  ['ITEM-DEMO-005', 'USB-C Hub', 'inventory', 'PCS', 250_000, 375_000],
  ['ITEM-DEMO-006', 'HDMI Cable', 'inventory', 'PCS', 60_000, 100_000],
  ['ITEM-DEMO-007', 'LAN Cable 5 Meter', 'inventory', 'PCS', 35_000, 65_000],
  ['ITEM-DEMO-008', 'SSD 1TB', 'inventory', 'PCS', 900_000, 1_200_000],
  ['ITEM-DEMO-009', 'RAM 16GB', 'inventory', 'PCS', 600_000, 850_000],
  ['ITEM-DEMO-010', 'Printer Ink', 'inventory', 'PCS', 150_000, 225_000],
  ['ITEM-DEMO-011', 'A4 Paper', 'inventory', 'REAM', 45_000, 60_000],
  ['ITEM-DEMO-012', 'Office Pen', 'inventory', 'PACK', 25_000, 40_000],
  ['ITEM-DEMO-013', 'Notebook', 'inventory', 'PCS', 15_000, 25_000],
  ['ITEM-DEMO-014', 'Office Chair', 'inventory', 'UNIT', 700_000, 1_050_000],
  ['ITEM-DEMO-015', 'Office Desk', 'inventory', 'UNIT', 1_000_000, 1_500_000],
  ['ITEM-DEMO-016', 'Web Development Service', 'service', 'UNIT', 0, 15_000_000],
  ['ITEM-DEMO-017', 'IT Support Service', 'service', 'UNIT', 0, 5_000_000],
  ['ITEM-DEMO-018', 'Consulting Service', 'service', 'UNIT', 0, 8_000_000],
  ['ITEM-DEMO-019', 'Network Setup Service', 'service', 'UNIT', 0, 3_500_000],
  ['ITEM-DEMO-020', 'Software Installation', 'service', 'UNIT', 0, 1_500_000],
  ['ITEM-DEMO-021', 'Webcam Full HD', 'inventory', 'PCS', 500_000, 750_000],
  ['ITEM-DEMO-022', 'Headset Conference', 'inventory', 'PCS', 400_000, 625_000],
  ['ITEM-DEMO-023', 'Router Gigabit', 'inventory', 'PCS', 650_000, 950_000],
  ['ITEM-DEMO-024', 'UPS 1200VA', 'inventory', 'UNIT', 1_100_000, 1_500_000],
  ['ITEM-DEMO-025', 'External SSD 1TB', 'inventory', 'PCS', 1_000_000, 1_350_000],
  ['ITEM-DEMO-026', 'Cloud Migration Service', 'service', 'HOUR', 0, 750_000],
  ['ITEM-DEMO-027', 'Security Audit Service', 'service', 'HOUR', 0, 900_000],
  ['ITEM-DEMO-028', 'ERP Training', 'service', 'HOUR', 0, 500_000],
  ['ITEM-DEMO-029', 'Server Maintenance', 'service', 'HOUR', 0, 650_000],
  ['ITEM-DEMO-030', 'Data Recovery Service', 'service', 'HOUR', 0, 1_000_000],
] as const

async function idMap(connection: SeedConnection, table: string, key: string): Promise<Lookup> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT id, ${key} AS lookup_key FROM ${table} WHERE company_id = ?`,
    [COMPANY_ID],
  )
  return Object.fromEntries(rows.map((row) => [String(row.lookup_key), Number(row.id)]))
}

async function seedMaster(connection: SeedConnection) {
  await connection.execute(
    `INSERT INTO accounting_periods(company_id,year,month,start_date,end_date,status)
     VALUES(?,'2025',12,'2025-12-01','2025-12-31','closed')
     ON DUPLICATE KEY UPDATE start_date=VALUES(start_date),end_date=VALUES(end_date),status='closed'`,
    [COMPANY_ID],
  )
  const password = await hashPassword(DEMO_PASSWORD)
  await connection.execute(
    `INSERT INTO users(company_id,name,email,password,status,password_changed_at)
     VALUES(?, 'Finora Demo Administrator', ?, ?, 'active', NOW())
     ON DUPLICATE KEY UPDATE name=VALUES(name),password=VALUES(password),status='active',deleted_at=NULL`,
    [COMPANY_ID, DEMO_EMAIL, password],
  )
  const [users] = await connection.execute<(RowDataPacket & { id: number })[]>(
    'SELECT id FROM users WHERE email=? LIMIT 1',
    [DEMO_EMAIL],
  )
  actor.userId = Number(users[0]?.id)
  if (!actor.userId) throw new Error('Demo user gagal dibuat')
  await connection.execute(
    `INSERT IGNORE INTO user_roles(user_id,role_id)
     SELECT ?,id FROM roles WHERE slug='super-admin' LIMIT 1`,
    [actor.userId],
  )

  for (const [code, name, type, normal, cashFlow] of accounts) {
    await connection.execute(
      `INSERT INTO accounts(company_id,code,name,account_type,normal_balance,is_header,is_posting,is_active,allow_manual_journal,cash_flow_category)
       VALUES(?,?,?,?,?,FALSE,TRUE,TRUE,TRUE,?)
       ON DUPLICATE KEY UPDATE name=VALUES(name),account_type=VALUES(account_type),normal_balance=VALUES(normal_balance),
         is_header=FALSE,is_posting=TRUE,is_active=TRUE,allow_manual_journal=TRUE,cash_flow_category=VALUES(cash_flow_category),deleted_at=NULL`,
      [COMPANY_ID, code, name, type, normal, cashFlow],
    )
  }
  const accountIds = await idMap(connection, 'accounts', 'code')
  await connection.execute(
    `INSERT INTO settings(company_id,setting_key,setting_value,category,value_type)
     VALUES(?,'goods_received_not_invoiced_account_id',?,'purchases','account_id')
     ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value),category=VALUES(category),value_type=VALUES(value_type)`,
    [COMPANY_ID, String(accountIds['2111'])],
  )

  for (const [code, name, symbol] of [
    ['UNIT', 'Unit', 'unit'],
    ['PCS', 'Pieces', 'pcs'],
    ['REAM', 'Ream', 'ream'],
    ['PACK', 'Pack', 'pack'],
    ['HOUR', 'Hour', 'hour'],
  ]) {
    await connection.execute(
      `INSERT INTO units(company_id,code,name,symbol,is_active) VALUES(?,?,?,?,TRUE)
       ON DUPLICATE KEY UPDATE name=VALUES(name),symbol=VALUES(symbol),is_active=TRUE`,
      [COMPANY_ID, code, name, symbol],
    )
  }
  for (const [code, name, address] of [
    ['WH-DEMO-01', 'Gudang Utama', 'Jl. Industri Demo No. 1, Tangerang'],
    ['WH-DEMO-02', 'Gudang Bandung', 'Jl. Asia Afrika Demo No. 22, Bandung'],
    ['WH-DEMO-03', 'Gudang Jakarta', 'Jl. Gatot Subroto Demo No. 10, Jakarta'],
  ]) {
    await connection.execute(
      `INSERT INTO warehouses(company_id,code,name,address,is_active) VALUES(?,?,?,?,TRUE)
       ON DUPLICATE KEY UPDATE name=VALUES(name),address=VALUES(address),is_active=TRUE`,
      [COMPANY_ID, code, name, address],
    )
  }
  for (const [code, name, inputId, outputId] of [
    ['PPN-IN', 'Input VAT 11%', accountIds['1150'], accountIds['2201']],
    ['PPN-OUT', 'Output VAT 11%', accountIds['1150'], accountIds['2201']],
    ['NON-PPN', 'Non PPN', null, null],
  ]) {
    await connection.execute(
      `INSERT INTO tax_codes(company_id,code,name,tax_type,rate,input_tax_account_id,output_tax_account_id,is_active)
       VALUES(?,?,?,'vat',?,?,?,TRUE)
       ON DUPLICATE KEY UPDATE name=VALUES(name),rate=VALUES(rate),input_tax_account_id=VALUES(input_tax_account_id),
         output_tax_account_id=VALUES(output_tax_account_id),is_active=TRUE`,
      [COMPANY_ID, code, name, code === 'NON-PPN' ? 0 : 11, inputId, outputId],
    )
  }
  for (const [code, name] of [
    ['CC-DEMO-HO', 'Head Office'],
    ['CC-DEMO-FIN', 'Finance'],
    ['CC-DEMO-SALES', 'Sales'],
    ['CC-DEMO-OPS', 'Operations'],
    ['CC-DEMO-IT', 'Information Technology'],
  ]) {
    await connection.execute(
      `INSERT INTO cost_centers(company_id,code,name,is_active) VALUES(?,?,?,TRUE)
       ON DUPLICATE KEY UPDATE name=VALUES(name),is_active=TRUE`,
      [COMPANY_ID, code, name],
    )
  }

  const customers = [
    'PT Maju Jaya Abadi',
    'PT Nusantara Digital',
    'CV Sejahtera Bersama',
    'PT Karya Teknologi',
    'PT Sentosa Retail',
    'CV Prima Office',
    'PT Bandung Makmur',
    'PT Jakarta Niaga',
    'PT Arunika Solusi',
    'PT Pelanggan Nonaktif',
    'CV Mitra Usaha Demo',
    'PT Lentera Data Indonesia',
    'PT Bumi Kreatif Demo',
    'CV Harmoni Niaga',
    'PT Garuda Sistem Demo',
    'PT Pilar Informatika Demo',
    'CV Sinar Digital Demo',
    'PT Samudra Retail Demo',
    'PT Puncak Inovasi Demo',
    'PT Cakrawala Bisnis Demo',
  ]
  for (const [index, name] of customers.entries()) {
    const code = `CUST-DEMO-${String(index + 1).padStart(3, '0')}`
    await connection.execute(
      `INSERT INTO customers(company_id,code,name,email,phone,address,city,credit_limit,payment_term_days,receivable_account_id,currency,is_active)
       VALUES(?,?,?,?,?,'Alamat demo, Indonesia',?,500000000,30,?,'IDR',?)
       ON DUPLICATE KEY UPDATE name=VALUES(name),email=VALUES(email),phone=VALUES(phone),receivable_account_id=VALUES(receivable_account_id),currency='IDR',is_active=VALUES(is_active),deleted_at=NULL`,
      [
        COMPANY_ID,
        code,
        name,
        `customer${index + 1}@demo.invalid`,
        `0218800${String(index + 1).padStart(3, '0')}`,
        index === 6 ? 'Bandung' : 'Jakarta',
        accountIds['1130'],
        index !== 9,
      ],
    )
  }
  const suppliers = [
    'PT Sumber Barang Indonesia',
    'PT Elektronik Nusantara',
    'CV Perlengkapan Kantor',
    'PT Distribusi Teknologi',
    'PT Solusi Perangkat',
    'CV Karya Mandiri',
    'PT Logistik Demo',
    'PT Supplier Nonaktif',
    'CV Maju Bersama Demo',
    'PT Prima Distribusi Demo',
    'PT Karya Komponen Demo',
    'CV Sentra Peralatan Demo',
    'PT Nusantara Logistik Demo',
    'CV Andalan Industri Demo',
    'PT Sumber Teknologi Demo',
  ]
  for (const [index, name] of suppliers.entries()) {
    const code = `SUP-DEMO-${String(index + 1).padStart(3, '0')}`
    await connection.execute(
      `INSERT INTO suppliers(company_id,code,name,email,phone,address,city,payment_term_days,payable_account_id,currency,is_active)
       VALUES(?,?,?,?,?,'Alamat supplier demo, Indonesia','Jakarta',30,?,'IDR',?)
       ON DUPLICATE KEY UPDATE name=VALUES(name),email=VALUES(email),phone=VALUES(phone),payable_account_id=VALUES(payable_account_id),currency='IDR',is_active=VALUES(is_active),deleted_at=NULL`,
      [
        COMPANY_ID,
        code,
        name,
        `supplier${index + 1}@demo.invalid`,
        `0219900${String(index + 1).padStart(3, '0')}`,
        accountIds['2101'],
        index !== 7,
      ],
    )
  }
  const customerIds = await idMap(connection, 'customers', 'code')
  for (const [index, [code, name]] of [
    ['PRJ-DEMO-001', 'Implementasi ERP Internal'],
    ['PRJ-DEMO-002', 'Pengembangan Website'],
    ['PRJ-DEMO-003', 'Ekspansi Cabang Bandung'],
    ['PRJ-DEMO-004', 'Marketing Campaign 2026'],
    ['PRJ-DEMO-005', 'Modernisasi Infrastruktur'],
  ].entries()) {
    await connection.execute(
      `INSERT INTO projects(company_id,code,name,customer_id,start_date,end_date,status,budget,description)
       VALUES(?,?,?,?, '2026-01-01','2026-12-31',?,250000000,'Project demo Finance ERP')
       ON DUPLICATE KEY UPDATE name=VALUES(name),customer_id=VALUES(customer_id),status=VALUES(status),budget=VALUES(budget)`,
      [
        COMPANY_ID,
        code,
        name,
        customerIds[`CUST-DEMO-${String(index + 1).padStart(3, '0')}`],
        index === 0 ? 'completed' : 'active',
      ],
    )
  }

  const unitIds = await idMap(connection, 'units', 'code')
  for (const [index, [sku, name, type, unit, purchase, sales]] of itemData.entries()) {
    const inventory = type === 'inventory'
    await connection.execute(
      `INSERT INTO items(company_id,sku,name,description,item_type,unit_id,sales_account_id,inventory_account_id,cogs_account_id,purchase_account_id,sales_price,purchase_price,average_cost,minimum_stock,is_active)
       VALUES(?,?,?,'Demo item Finance ERP',?,?,?,?,?,?,?,?,?,5,?)
       ON DUPLICATE KEY UPDATE name=VALUES(name),item_type=VALUES(item_type),unit_id=VALUES(unit_id),sales_account_id=VALUES(sales_account_id),
         inventory_account_id=VALUES(inventory_account_id),cogs_account_id=VALUES(cogs_account_id),purchase_account_id=VALUES(purchase_account_id),
         sales_price=VALUES(sales_price),purchase_price=VALUES(purchase_price),average_cost=VALUES(average_cost),is_active=VALUES(is_active),deleted_at=NULL`,
      [
        COMPANY_ID,
        sku,
        name,
        type,
        unitIds[unit],
        inventory ? accountIds['4101'] : accountIds['4102'],
        inventory ? accountIds['1140'] : null,
        inventory ? accountIds['5101'] : null,
        inventory ? accountIds['5101'] : accountIds['6108'],
        sales,
        purchase,
        purchase,
        index !== 19,
      ],
    )
  }
  for (const [code, bankName, number, holder, gl, balance] of [
    ['BANK-DEMO-BCA', 'Bank BCA Demo', '8880000001', 'PT Finora Indonesia', '1102', 250_000_000],
    ['BANK-DEMO-MANDIRI', 'Bank Mandiri Demo', '8880000002', 'PT Finora Indonesia', '1103', 0],
  ]) {
    await connection.execute(
      `INSERT INTO bank_accounts(company_id,code,bank_name,account_number,account_name,currency,gl_account_id,opening_balance,current_balance,is_active,created_by)
       VALUES(?,?,?,?,?,'IDR',?,?,?,TRUE,?)
       ON DUPLICATE KEY UPDATE bank_name=VALUES(bank_name),account_name=VALUES(account_name),gl_account_id=VALUES(gl_account_id),opening_balance=VALUES(opening_balance),current_balance=VALUES(current_balance),is_active=TRUE,deleted_at=NULL`,
      [COMPANY_ID, code, bankName, number, holder, accountIds[gl], balance, balance, actor.userId],
    )
  }
}

async function state(table: string, field: string, reference: string) {
  const [rows] = await db.execute<StateRow[]>(
    `SELECT id,status FROM ${table} WHERE company_id=? AND ${field}=? LIMIT 1`,
    [COMPANY_ID, reference],
  )
  return rows[0] ?? null
}

async function lookups() {
  const connection = await db.getConnection()
  try {
    return {
      accounts: await idMap(connection, 'accounts', 'code'),
      customers: await idMap(connection, 'customers', 'code'),
      suppliers: await idMap(connection, 'suppliers', 'code'),
      units: await idMap(connection, 'units', 'code'),
      warehouses: await idMap(connection, 'warehouses', 'code'),
      taxes: await idMap(connection, 'tax_codes', 'code'),
      items: await idMap(connection, 'items', 'sku'),
      bankAccounts: await idMap(connection, 'bank_accounts', 'code'),
    }
  } finally {
    connection.release()
  }
}

async function seedOpenings(refs: Awaited<ReturnType<typeof lookups>>) {
  const opening = new OpeningBalanceService()
  await transaction(async (connection) => {
    const [gl] = await connection.execute<RowDataPacket[]>(
      "SELECT id FROM opening_balance_batches WHERE company_id=? AND batch_number='OPEN-DEMO-GL-2026' LIMIT 1",
      [COMPANY_ID],
    )
    if (!gl[0]) {
      await opening.createGeneralLedger(
        connection,
        {
          companyId: COMPANY_ID,
          batchNumber: 'OPEN-DEMO-GL-2026',
          asOfDate: '2026-01-01',
          description: 'Saldo awal perusahaan demo',
          status: 'validated',
          lines: [
            { accountId: refs.accounts['1101']!, debit: 100_000_000, credit: 0 },
            { accountId: refs.accounts['1102']!, debit: 250_000_000, credit: 0 },
            { accountId: refs.accounts['1140']!, debit: 150_000_000, credit: 0 },
            { accountId: refs.accounts['1201']!, debit: 50_000_000, credit: 0 },
            { accountId: refs.accounts['3101']!, debit: 0, credit: 550_000_000 },
          ],
        },
        actor,
      )
    }
    const [inventory] = await connection.execute<RowDataPacket[]>(
      "SELECT id FROM opening_balance_batches WHERE company_id=? AND batch_number='OPEN-DEMO-INV-2026' LIMIT 1",
      [COMPANY_ID],
    )
    if (!inventory[0]) {
      const quantities = [20, 30, 50, 60, 40, 100, 100, 25, 30, 50, 100, 100, 150, 10, 10]
      const primary = itemData.slice(0, 15).map(([sku, , , , purchase], index) => ({
        itemId: refs.items[sku]!,
        warehouseId: refs.warehouses['WH-DEMO-01']!,
        quantity: quantities[index]!,
        unitCost: purchase,
        documentNumber: 'OPEN-DEMO-INV-2026',
      }))
      const secondary = [
        { sku: 'ITEM-DEMO-001', warehouse: 'WH-DEMO-02', quantity: 5, cost: 7_000_000 },
        { sku: 'ITEM-DEMO-003', warehouse: 'WH-DEMO-02', quantity: 10, cost: 450_000 },
        { sku: 'ITEM-DEMO-011', warehouse: 'WH-DEMO-02', quantity: 20, cost: 45_000 },
        { sku: 'ITEM-DEMO-002', warehouse: 'WH-DEMO-03', quantity: 8, cost: 1_500_000 },
        { sku: 'ITEM-DEMO-004', warehouse: 'WH-DEMO-03', quantity: 15, cost: 180_000 },
        { sku: 'ITEM-DEMO-013', warehouse: 'WH-DEMO-03', quantity: 30, cost: 15_000 },
      ].map((entry) => ({
        itemId: refs.items[entry.sku]!,
        warehouseId: refs.warehouses[entry.warehouse]!,
        quantity: entry.quantity,
        unitCost: entry.cost,
        documentNumber: 'OPEN-DEMO-INV-2026',
      }))
      await opening.createInventory(
        connection,
        {
          companyId: COMPANY_ID,
          batchNumber: 'OPEN-DEMO-INV-2026',
          asOfDate: '2026-01-02',
          description: 'Stock awal multi-gudang demo',
          status: 'validated',
          lines: [...primary, ...secondary],
        },
        actor,
      )
    }
  })
}

const orderLines = (refs: Awaited<ReturnType<typeof lookups>>, start: number) => [
  {
    item_id: refs.items[`ITEM-DEMO-${String(start).padStart(3, '0')}`]!,
    quantity: '10.0000',
    unit_id: refs.units[start === 1 || start === 2 ? 'UNIT' : 'PCS']!,
    unit_price: String(itemData[start - 1]![4]),
    discount_amount: '0.00',
    discount_percent: '0.0000',
    tax_code_id: refs.taxes['PPN-IN']!,
  },
  {
    item_id: refs.items[`ITEM-DEMO-${String(start + 1).padStart(3, '0')}`]!,
    quantity: '5.0000',
    unit_id: refs.units[start + 1 === 2 ? 'UNIT' : 'PCS']!,
    unit_price: String(itemData[start]![4]),
    discount_amount: '0.00',
    discount_percent: '0.0000',
    tax_code_id: refs.taxes['PPN-IN']!,
  },
]

async function seedPurchaseOrders(refs: Awaited<ReturnType<typeof lookups>>) {
  const service = new PurchaseOrderService()
  for (let index = 1; index <= 4; index++) {
    const reference = `PUR-PO-DEMO-${String(index).padStart(3, '0')}`
    let current = await state('purchase_orders', 'supplier_reference', reference)
    if (!current) {
      const created = await service.create(
        COMPANY_ID,
        purchaseOrderSchema.parse({
          order_date: `2026-0${index + 1}-05`,
          supplier_id: refs.suppliers[`SUP-DEMO-${String(index).padStart(3, '0')}`],
          warehouse_id: refs.warehouses['WH-DEMO-01'],
          payment_term_days: 30,
          expected_date: `2026-0${index + 1}-20`,
          supplier_reference: reference,
          currency: 'IDR',
          exchange_rate: '1',
          notes: `Demo purchase order ${reference}`,
          lines: orderLines(refs, index * 2 - 1),
        }),
        actor,
      )
      current = { id: created.id, status: created.status } as StateRow
    }
    if (index > 1 && current.status === 'draft')
      await service.confirm(current.id, COMPANY_ID, actor)
  }
}

async function seedGoodsReceipts(refs: Awaited<ReturnType<typeof lookups>>) {
  const service = new GoodsReceiptService()
  const [orders] = await db.execute<RowDataPacket[]>(
    `SELECT id,supplier_reference FROM purchase_orders WHERE company_id=? AND supplier_reference IN ('PUR-PO-DEMO-003','PUR-PO-DEMO-004')`,
    [COMPANY_ID],
  )
  for (const order of orders) {
    const [lines] = await db.execute<RowDataPacket[]>(
      'SELECT id,quantity FROM purchase_order_lines WHERE purchase_order_id=? ORDER BY id',
      [order.id],
    )
    const scenarios = String(order.supplier_reference).endsWith('003')
      ? [
          { reference: 'GR-DEMO-001', quantities: [6, 0] },
          { reference: 'GR-DEMO-002', quantities: [4, Number(lines[1]?.quantity ?? 0)] },
        ]
      : [{ reference: 'GR-DEMO-003', quantities: lines.map((line) => Number(line.quantity)) }]
    for (const scenario of scenarios) {
      let current = await state('goods_receipts', 'reference', scenario.reference)
      if (!current) {
        const created = await service.create(
          COMPANY_ID,
          goodsReceiptSchema.parse({
            receipt_date: String(order.supplier_reference).endsWith('003')
              ? '2026-05-20'
              : '2026-06-20',
            purchase_order_id: Number(order.id),
            supplier_delivery_number: `${scenario.reference}-SJ`,
            reference: scenario.reference,
            notes: 'Goods receipt demo melalui production service',
            lines: lines
              .map((line, index) => ({
                purchase_order_line_id: Number(line.id),
                quantity: String(scenario.quantities[index] ?? 0),
              }))
              .filter((line) => Number(line.quantity) > 0),
          }),
          actor,
        )
        current = { id: created.id, status: created.status } as StateRow
      }
      if (current.status === 'draft') await service.post(current.id, COMPANY_ID, actor)
    }
  }
  void refs
}

async function advanceInvoice(
  kind: 'sales' | 'purchase',
  id: number,
  desired: string,
  currentStatus: string,
  service: SalesInvoiceService | PurchaseInvoiceService,
) {
  let status = currentStatus
  if (desired === 'cancelled' && ['draft', 'rejected'].includes(status)) {
    await service.cancel(id, COMPANY_ID, 'Demo cancelled scenario', actor)
    return
  }
  if (status === 'draft' && desired !== 'draft') {
    await service.submit(id, COMPANY_ID, actor)
    status = 'pending_approval'
  }
  if (desired === 'rejected' && status === 'pending_approval') {
    await service.reject(id, COMPANY_ID, 'Demo rejected scenario', actor)
    return
  }
  if (status === 'pending_approval' && ['approved', 'posted'].includes(desired)) {
    await service.approve(id, COMPANY_ID, actor)
    status = 'approved'
  }
  if (status === 'approved' && desired === 'posted') await service.post(id, COMPANY_ID, actor)
  void kind
}

async function seedPurchaseInvoices(refs: Awaited<ReturnType<typeof lookups>>) {
  const service = new PurchaseInvoiceService()
  const desired = [
    'posted',
    'posted',
    'approved',
    'pending_approval',
    'rejected',
    'cancelled',
    'draft',
    'posted',
  ]
  for (let index = 1; index <= 8; index++) {
    const reference = `PUR-DEMO-${String(index).padStart(3, '0')}`
    let current = await state('purchase_invoices', 'supplier_invoice_number', reference)
    if (!current) {
      const itemIndex = (((index - 1) * 2) % 14) + 1
      const lines = [itemIndex, itemIndex + 1].map((number, lineIndex) => ({
        item_id: refs.items[`ITEM-DEMO-${String(number).padStart(3, '0')}`],
        quantity: lineIndex === 0 ? '5.0000' : '10.0000',
        unit_id:
          refs.units[
            number <= 2 || number >= 14
              ? 'UNIT'
              : number === 11
                ? 'REAM'
                : number === 12
                  ? 'PACK'
                  : 'PCS'
          ],
        unit_price: String(itemData[number - 1]![4]),
        discount: '0.00',
        discount_percent: '0.0000',
        tax_code_id: refs.taxes['PPN-IN'],
        expense_account_id: refs.accounts['1140'],
      }))
      const created = await service.create(
        COMPANY_ID,
        purchaseInvoiceSchema.parse({
          supplier_invoice_number: reference,
          invoice_date: `2026-${String(index + 1).padStart(2, '0')}-08`,
          due_date: `2026-${String(index + 1).padStart(2, '0')}-28`,
          supplier_id: refs.suppliers[`SUP-DEMO-${String(((index - 1) % 7) + 1).padStart(3, '0')}`],
          warehouse_id: refs.warehouses['WH-DEMO-01'],
          reference,
          notes: 'Purchase invoice demo',
          currency: 'IDR',
          exchange_rate: '1',
          lines,
        }),
        actor,
      )
      current = { id: created.id, status: created.status } as StateRow
    }
    await advanceInvoice('purchase', current.id, desired[index - 1]!, current.status, service)
  }
}

async function seedSalesOrders(refs: Awaited<ReturnType<typeof lookups>>) {
  const service = new SalesOrderService()
  for (let index = 1; index <= 4; index++) {
    const reference = `SO-DEMO-${String(index).padStart(3, '0')}`
    let current = await state('sales_orders', 'reference', reference)
    if (!current) {
      const start = index * 2 - 1
      const created = await service.create(
        COMPANY_ID,
        salesOrderSchema.parse({
          order_date: `2026-0${index + 1}-10`,
          customer_id: refs.customers[`CUST-DEMO-${String(index).padStart(3, '0')}`],
          warehouse_id: refs.warehouses['WH-DEMO-01'],
          payment_term_days: 30,
          expected_date: `2026-0${index + 1}-25`,
          reference,
          currency: 'IDR',
          exchange_rate: '1',
          notes: `Demo sales order ${reference}`,
          lines: [start, start + 1].map((number) => ({
            item_id: refs.items[`ITEM-DEMO-${String(number).padStart(3, '0')}`],
            quantity: '2.0000',
            unit_id: refs.units[number <= 2 ? 'UNIT' : 'PCS'],
            unit_price: String(itemData[number - 1]![5]),
            discount_amount: '0.00',
            discount_percent: '0.0000',
            tax_code_id: refs.taxes['PPN-OUT'],
          })),
        }),
        actor,
      )
      current = { id: created.id, status: created.status } as StateRow
    }
    if ([2, 3].includes(index) && current.status === 'draft')
      await service.confirm(current.id, COMPANY_ID, actor)
    if (index === 4 && ['draft', 'confirmed'].includes(current.status))
      await service.cancel(current.id, COMPANY_ID, 'Demo cancelled order', actor)
  }
}

async function seedSalesInvoices(refs: Awaited<ReturnType<typeof lookups>>) {
  const service = new SalesInvoiceService()
  const desired = [
    'posted',
    'posted',
    'posted',
    'pending_approval',
    'approved',
    'rejected',
    'cancelled',
    'posted',
    'draft',
    'posted',
    'pending_approval',
    'approved',
  ]
  for (let index = 1; index <= 12; index++) {
    const reference = `INV-DEMO-${String(index).padStart(3, '0')}`
    let current = await state('sales_invoices', 'reference', reference)
    if (!current) {
      const serviceItem = index === 3
      const numbers = serviceItem ? [16] : [((index - 1) % 14) + 1, (index % 14) + 1]
      const lines = numbers.map((number, lineIndex) => ({
        item_id: refs.items[`ITEM-DEMO-${String(number).padStart(3, '0')}`],
        quantity: serviceItem ? '1.0000' : lineIndex === 0 ? '2.0000' : '3.0000',
        unit_id:
          refs.units[
            number <= 2 || number >= 14
              ? 'UNIT'
              : number === 11
                ? 'REAM'
                : number === 12
                  ? 'PACK'
                  : 'PCS'
          ],
        unit_price: String(itemData[number - 1]![5]),
        discount: '0.00',
        discount_percent: '0.0000',
        tax_code_id: refs.taxes['PPN-OUT'],
        revenue_account_id: refs.accounts[number >= 16 ? '4102' : '4101'],
      }))
      const month = ((index - 1) % 9) + 1
      const created = await service.create(
        COMPANY_ID,
        salesInvoiceSchema.parse({
          invoice_date: `2026-${String(month).padStart(2, '0')}-15`,
          due_date: `2026-${String(month).padStart(2, '0')}-28`,
          customer_id:
            refs.customers[`CUST-DEMO-${String(((index - 1) % 9) + 1).padStart(3, '0')}`],
          warehouse_id: serviceItem ? null : refs.warehouses['WH-DEMO-01'],
          reference,
          notes: 'Sales invoice demo',
          currency: 'IDR',
          exchange_rate: '1',
          lines,
        }),
        actor,
      )
      current = { id: created.id, status: created.status } as StateRow
    }
    await advanceInvoice('sales', current.id, desired[index - 1]!, current.status, service)
  }
}

async function seedSalesReturns() {
  const service = new SalesReturnService()
  for (const [index, invoiceReference] of ['INV-DEMO-001', 'INV-DEMO-002'].entries()) {
    const reference = `RET-DEMO-${String(index + 1).padStart(3, '0')}`
    let current = await state('sales_returns', 'reference', reference)
    if (!current) {
      const [invoiceRows] = await db.execute<RowDataPacket[]>(
        `SELECT id FROM sales_invoices WHERE company_id=? AND reference=? AND status='posted' LIMIT 1`,
        [COMPANY_ID, invoiceReference],
      )
      const invoiceId = Number(invoiceRows[0]?.id)
      if (!invoiceId) throw new Error(`Invoice sumber retur ${invoiceReference} tidak ditemukan`)
      const [lineRows] = await db.execute<RowDataPacket[]>(
        'SELECT id,quantity FROM sales_invoice_lines WHERE sales_invoice_id=? ORDER BY line_number LIMIT 1',
        [invoiceId],
      )
      const sourceLine = lineRows[0]
      const created = await service.create(
        COMPANY_ID,
        salesReturnSchema.parse({
          return_date: `2026-09-${String(10 + index).padStart(2, '0')}`,
          sales_invoice_id: invoiceId,
          reference,
          reason: index === 0 ? 'Partial return demo - kemasan rusak' : 'Full line return demo - spesifikasi tidak sesuai',
          lines: [{
            sales_invoice_line_id: Number(sourceLine?.id),
            quantity: index === 0 ? '1.0000' : String(sourceLine?.quantity),
            reason: 'Retur valid untuk demonstrasi workflow',
          }],
        }),
        actor,
      )
      current = { id: created.id, status: created.status } as StateRow
    }
    if (current.status === 'draft') {
      await service.submit(current.id, COMPANY_ID, actor)
      current.status = 'pending_approval'
    }
    if (current.status === 'pending_approval') await service.approve(current.id, COMPANY_ID, actor)
  }
}

const journalFixtures = [
  ['JRN-DEMO-001', '2026-02-05', 'Rent Expense', '6102', '1102', 10_000_000],
  ['JRN-DEMO-002', '2026-03-05', 'Electricity', '6103', '1102', 2_500_000],
  ['JRN-DEMO-003', '2026-04-05', 'Internet', '6104', '1102', 1_500_000],
  ['JRN-DEMO-004', '2026-05-05', 'Salary', '6101', '1102', 30_000_000],
  ['JRN-DEMO-005', '2026-06-05', 'Office Supplies', '6105', '1101', 3_000_000],
  ['JRN-DEMO-006', '2026-07-05', 'Transportation', '6106', '1101', 1_250_000],
  ['JRN-DEMO-007', '2026-07-15', 'Interest income', '1102', '7101', 500_000],
  ['JRN-DEMO-008', '2026-08-05', 'Bank fee', '8101', '1102', 150_000],
  ['JRN-DEMO-009', '2026-08-15', 'Equipment purchase cash', '1201', '1102', 5_000_000],
  ['JRN-DEMO-010', '2026-09-05', 'Depreciation', '6107', '1202', 1_000_000],
] as const

async function seedJournals(refs: Awaited<ReturnType<typeof lookups>>) {
  const service = new JournalService()
  const desired = [
    'posted',
    'posted',
    'posted',
    'posted',
    'posted',
    'pending_approval',
    'approved',
    'rejected',
    'draft',
    'posted',
  ]
  for (const [
    index,
    [reference, date, description, debitCode, creditCode, amount],
  ] of journalFixtures.entries()) {
    let current = await state('journals', 'reference', reference)
    if (!current) {
      const created = await service.create(
        COMPANY_ID,
        journalSchema.parse({
          journal_date: date,
          reference,
          description,
          currency: 'IDR',
          exchange_rate: '1',
          lines: [
            {
              accountId: refs.accounts[debitCode],
              description,
              debit: String(amount),
              credit: '0',
            },
            {
              accountId: refs.accounts[creditCode],
              description,
              debit: '0',
              credit: String(amount),
            },
          ],
        }),
        actor,
      )
      current = { id: created.id, status: created.status } as StateRow
    }
    const target = desired[index]!
    let status = current.status
    if (status === 'draft' && target !== 'draft') {
      await service.submit(current.id, COMPANY_ID, actor)
      status = 'pending_approval'
    }
    if (target === 'rejected' && status === 'pending_approval') {
      await service.reject(current.id, COMPANY_ID, 'Demo journal rejected', actor)
      continue
    }
    if (status === 'pending_approval' && ['approved', 'posted'].includes(target)) {
      await service.approve(current.id, COMPANY_ID, actor)
      status = 'approved'
    }
    if (status === 'approved' && target === 'posted')
      await service.post(current.id, COMPANY_ID, actor)
  }
}

async function seedBankStatement(refs: Awaited<ReturnType<typeof lookups>>) {
  const [existing] = await db.execute<RowDataPacket[]>(
    "SELECT id FROM bank_statements WHERE company_id=? AND statement_number='BST-DEMO-BCA-2026-08' LIMIT 1",
    [COMPANY_ID],
  )
  if (existing[0]) return
  await transaction(async (connection) => {
    await new BankStatementService().create(
      connection,
      {
        companyId: COMPANY_ID,
        bankAccountId: refs.bankAccounts['BANK-DEMO-BCA']!,
        statementNumber: 'BST-DEMO-BCA-2026-08',
        periodStart: '2026-08-01',
        periodEnd: '2026-08-31',
        openingBalance: '250000000',
        closingBalance: '247850000',
        status: 'imported',
        balanceConvention: 'debit_increases',
        fileName: 'demo-bank-statement.csv',
        checksum: 'finora-demo-bank-statement-2026-08',
        lines: [
          { transactionDate: '2026-08-05', description: 'Pembayaran utilitas demo', reference: 'JRN-DEMO-003', debit: 0, credit: 1_500_000, balance: 248_500_000, externalId: 'BST-DEMO-001' },
          { transactionDate: '2026-08-15', description: 'Pendapatan bunga demo', reference: 'JRN-DEMO-007', debit: 500_000, credit: 0, balance: 249_000_000, externalId: 'BST-DEMO-002' },
          { transactionDate: '2026-08-20', description: 'Biaya administrasi bank demo', reference: 'JRN-DEMO-008', debit: 0, credit: 150_000, balance: 248_850_000, externalId: 'BST-DEMO-003' },
          { transactionDate: '2026-08-25', description: 'Pembelian peralatan demo', reference: 'JRN-DEMO-009', debit: 0, credit: 1_000_000, balance: 247_850_000, externalId: 'BST-DEMO-004' },
        ],
      },
      actor,
    )
  })
}

export interface DemoVerification {
  counts: Record<string, number>
  postedDebit: number
  postedCredit: number
  negativeInventory: number
  arMismatch: number
  apMismatch: number
  tableCounts: Record<string, number>
  orphanRecords: number
  unbalancedJournals: number
  inventoryMismatch: number
  trialBalanceDifference: number
  balanceSheetDifference: number
}

export async function verifyDemoData(): Promise<DemoVerification> {
  const countQueries: Record<string, string> = {
    Company: 'SELECT COUNT(*) total FROM companies WHERE id=1',
    Users: "SELECT COUNT(*) total FROM users WHERE email LIKE '%@finora.local'",
    Accounts:
      'SELECT COUNT(*) total FROM accounts WHERE company_id=1 AND code IN (' +
      accounts.map(() => '?').join(',') +
      ')',
    Customers:
      "SELECT COUNT(*) total FROM customers WHERE company_id=1 AND code LIKE 'CUST-DEMO-%'",
    Suppliers: "SELECT COUNT(*) total FROM suppliers WHERE company_id=1 AND code LIKE 'SUP-DEMO-%'",
    Units:
      "SELECT COUNT(*) total FROM units WHERE company_id=1 AND code IN ('UNIT','PCS','REAM','PACK','HOUR')",
    Warehouses:
      "SELECT COUNT(*) total FROM warehouses WHERE company_id=1 AND code LIKE 'WH-DEMO-%'",
    TaxCodes:
      "SELECT COUNT(*) total FROM tax_codes WHERE company_id=1 AND code IN ('PPN-IN','PPN-OUT','NON-PPN')",
    CostCenters:
      "SELECT COUNT(*) total FROM cost_centers WHERE company_id=1 AND code LIKE 'CC-DEMO-%'",
    Projects: "SELECT COUNT(*) total FROM projects WHERE company_id=1 AND code LIKE 'PRJ-DEMO-%'",
    BankAccounts:
      "SELECT COUNT(*) total FROM bank_accounts WHERE company_id=1 AND code LIKE 'BANK-DEMO-%'",
    BankStatements:
      "SELECT COUNT(*) total FROM bank_statements WHERE company_id=1 AND statement_number LIKE 'BST-DEMO-%'",
    BankStatementLines:
      "SELECT COUNT(*) total FROM bank_statement_lines l JOIN bank_statements h ON h.id=l.bank_statement_id WHERE h.company_id=1 AND h.statement_number LIKE 'BST-DEMO-%'",
    Items: "SELECT COUNT(*) total FROM items WHERE company_id=1 AND sku LIKE 'ITEM-DEMO-%'",
    SalesOrders:
      "SELECT COUNT(*) total FROM sales_orders WHERE company_id=1 AND reference LIKE 'SO-DEMO-%'",
    SalesInvoices:
      "SELECT COUNT(*) total FROM sales_invoices WHERE company_id=1 AND reference LIKE 'INV-DEMO-%'",
    SalesReturns:
      "SELECT COUNT(*) total FROM sales_returns WHERE company_id=1 AND reference LIKE 'RET-DEMO-%'",
    SalesReturnLines:
      "SELECT COUNT(*) total FROM sales_return_lines l JOIN sales_returns h ON h.id=l.sales_return_id WHERE h.company_id=1 AND h.reference LIKE 'RET-DEMO-%'",
    PurchaseOrders:
      "SELECT COUNT(*) total FROM purchase_orders WHERE company_id=1 AND supplier_reference LIKE 'PUR-PO-DEMO-%'",
    PurchaseInvoices:
      "SELECT COUNT(*) total FROM purchase_invoices WHERE company_id=1 AND supplier_invoice_number LIKE 'PUR-DEMO-%'",
    GoodsReceipts:
      "SELECT COUNT(*) total FROM goods_receipts WHERE company_id=1 AND reference LIKE 'GR-DEMO-%'",
    Journals:
      "SELECT COUNT(*) total FROM journals WHERE company_id=1 AND reference LIKE 'JRN-DEMO-%'",
    InventoryMovements:
      "SELECT COUNT(*) total FROM inventory_movements WHERE company_id=1 AND (reference LIKE '%DEMO%' OR transaction_number LIKE '%DEMO%')",
  }
  const counts: Record<string, number> = {}
  for (const [label, sql] of Object.entries(countQueries)) {
    const params = label === 'Accounts' ? accounts.map(([code]) => code) : []
    const [rows] = await db.execute<RowDataPacket[]>(sql, params)
    counts[label] = Number(rows[0]?.total ?? 0)
  }
  const minimums: Record<string, number> = {
    Company: 1,
    Users: 1,
    Accounts: 25,
    Customers: 20,
    Suppliers: 15,
    Units: 5,
    Warehouses: 3,
    TaxCodes: 3,
    CostCenters: 5,
    Projects: 5,
    BankAccounts: 2,
    BankStatements: 1,
    BankStatementLines: 4,
    Items: 30,
    SalesOrders: 4,
    SalesInvoices: 12,
    SalesReturns: 2,
    SalesReturnLines: 2,
    PurchaseOrders: 4,
    PurchaseInvoices: 8,
    GoodsReceipts: 3,
    Journals: 10,
    InventoryMovements: 40,
  }
  for (const [label, minimum] of Object.entries(minimums)) {
    if ((counts[label] ?? 0) < minimum)
      throw new Error(`${label} demo kurang: ${counts[label] ?? 0}, minimum ${minimum}`)
  }
  const [totals] = await db.execute<RowDataPacket[]>(
    `SELECT COALESCE(SUM(jl.debit),0) debit,COALESCE(SUM(jl.credit),0) credit
     FROM journal_lines jl INNER JOIN journals j ON j.id=jl.journal_id WHERE j.company_id=? AND j.status='posted'`,
    [COMPANY_ID],
  )
  const [negative] = await db.execute<RowDataPacket[]>(
    'SELECT COUNT(*) total FROM inventory_balances WHERE company_id=? AND quantity<0',
    [COMPANY_ID],
  )
  const [ar] = await db.execute<RowDataPacket[]>(
    `SELECT COUNT(*) total FROM sales_invoices WHERE company_id=? AND ABS(outstanding_amount-(grand_total-paid_amount))>0.01`,
    [COMPANY_ID],
  )
  const [ap] = await db.execute<RowDataPacket[]>(
    `SELECT COUNT(*) total FROM purchase_invoices WHERE company_id=? AND ABS(outstanding_amount-(grand_total-paid_amount))>0.01`,
    [COMPANY_ID],
  )
  const [tables] = await db.execute<RowDataPacket[]>(
    `SELECT table_name AS tableName FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY table_name`,
  )
  const tableCounts: Record<string, number> = {}
  for (const table of tables) {
    const name = String(table.tableName)
    const [rows] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) total FROM \`${name}\``)
    tableCounts[name] = Number(rows[0]?.total ?? 0)
  }
  const orphanQueries = [
    'SELECT COUNT(*) total FROM sales_invoice_lines l LEFT JOIN sales_invoices h ON h.id=l.sales_invoice_id WHERE h.id IS NULL',
    'SELECT COUNT(*) total FROM purchase_invoice_lines l LEFT JOIN purchase_invoices h ON h.id=l.purchase_invoice_id WHERE h.id IS NULL',
    'SELECT COUNT(*) total FROM journal_lines l LEFT JOIN journals h ON h.id=l.journal_id WHERE h.id IS NULL',
    'SELECT COUNT(*) total FROM inventory_movements m LEFT JOIN items i ON i.id=m.item_id WHERE i.id IS NULL',
    'SELECT COUNT(*) total FROM goods_receipt_lines l LEFT JOIN goods_receipts h ON h.id=l.goods_receipt_id WHERE h.id IS NULL',
  ]
  let orphanRecords = 0
  for (const sql of orphanQueries) {
    const [rows] = await db.query<RowDataPacket[]>(sql)
    orphanRecords += Number(rows[0]?.total ?? 0)
  }
  const [unbalanced] = await db.execute<RowDataPacket[]>(
    `SELECT COUNT(*) total FROM (SELECT j.id FROM journals j JOIN journal_lines jl ON jl.journal_id=j.id WHERE j.company_id=? GROUP BY j.id HAVING ABS(SUM(jl.debit)-SUM(jl.credit))>0.01) x`,
    [COMPANY_ID],
  )
  const [inventoryReconciliation] = await db.execute<RowDataPacket[]>(
    `SELECT COUNT(*) total FROM inventory_balances b LEFT JOIN (SELECT company_id,item_id,warehouse_id,SUM(quantity_in-quantity_out) quantity FROM inventory_movements GROUP BY company_id,item_id,warehouse_id) m ON m.company_id=b.company_id AND m.item_id=b.item_id AND m.warehouse_id=b.warehouse_id WHERE b.company_id=? AND ABS(b.quantity-COALESCE(m.quantity,0))>0.0001`,
    [COMPANY_ID],
  )
  const result = {
    counts,
    postedDebit: Number(totals[0]?.debit ?? 0),
    postedCredit: Number(totals[0]?.credit ?? 0),
    negativeInventory: Number(negative[0]?.total ?? 0),
    arMismatch: Number(ar[0]?.total ?? 0),
    apMismatch: Number(ap[0]?.total ?? 0),
    tableCounts,
    orphanRecords,
    unbalancedJournals: Number(unbalanced[0]?.total ?? 0),
    inventoryMismatch: Number(inventoryReconciliation[0]?.total ?? 0),
    trialBalanceDifference: Number(totals[0]?.debit ?? 0) - Number(totals[0]?.credit ?? 0),
    balanceSheetDifference: Number(totals[0]?.debit ?? 0) - Number(totals[0]?.credit ?? 0),
  }
  if (Math.abs(result.postedDebit - result.postedCredit) > 0.01)
    throw new Error(
      `Posted journal tidak balance: debit ${result.postedDebit}, credit ${result.postedCredit}`,
    )
  if (result.negativeInventory)
    throw new Error(`${result.negativeInventory} inventory balance negatif`)
  if (result.arMismatch || result.apMismatch)
    throw new Error(`AR/AP mismatch: AR ${result.arMismatch}, AP ${result.apMismatch}`)
  if (result.orphanRecords || result.unbalancedJournals || result.inventoryMismatch)
    throw new Error(`Integrity mismatch: orphan ${result.orphanRecords}, unbalanced journals ${result.unbalancedJournals}, inventory ${result.inventoryMismatch}`)
  return result
}

function printSummary(result: DemoVerification) {
  console.info(
    '\n============================================\nFINORA DEMO DATA\n============================================',
  )
  for (const [label, count] of Object.entries(result.counts)) console.info(label.padEnd(28), count)
  console.info('--------------------------------------------')
  console.info('Posted journal debit'.padEnd(28), result.postedDebit)
  console.info('Posted journal credit'.padEnd(28), result.postedCredit)
  console.info('Negative inventory'.padEnd(28), result.negativeInventory)
  console.info('AR mismatch'.padEnd(28), result.arMismatch)
  console.info('AP mismatch'.padEnd(28), result.apMismatch)
  console.info('Orphan records'.padEnd(28), result.orphanRecords)
  console.info('Unbalanced journals'.padEnd(28), result.unbalancedJournals)
  console.info('Inventory mismatch'.padEnd(28), result.inventoryMismatch)
  console.info('Trial balance difference'.padEnd(28), result.trialBalanceDifference)
  console.info('Balance sheet difference'.padEnd(28), result.balanceSheetDifference)
  console.info('============================================')
}

export async function runDemoSeed(options: { printSummary?: boolean } = {}) {
  if (process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production') {
    throw new Error('Demo seeder tidak boleh dijalankan di production')
  }
  await transaction(seedMaster)
  const refs = await lookups()
  await seedOpenings(refs)
  await seedPurchaseOrders(refs)
  await seedGoodsReceipts(refs)
  await seedPurchaseInvoices(refs)
  await seedSalesOrders(refs)
  await seedSalesInvoices(refs)
  await seedSalesReturns()
  await seedJournals(refs)
  await seedBankStatement(refs)
  const result = await verifyDemoData()
  if (options.printSummary !== false) {
    printSummary(result)
    console.info(`\nLogin demo: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`)
    console.info('Company: PT Finora Indonesia')
  }
  return result
}
