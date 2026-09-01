import type { RowDataPacket } from 'mysql2/promise'
import { db, transaction } from '../config/database'
import { InventoryCostingService } from '../services/InventoryCostingService'
import { JournalService } from '../services/JournalService'
import { PurchaseInvoiceService } from '../services/PurchaseInvoiceService'
import { SalesInvoiceService } from '../services/SalesInvoiceService'
import { journalSchema } from '../validators/journal.validator'
import { purchaseInvoiceSchema } from '../validators/purchase-invoice.validator'
import { salesInvoiceSchema } from '../validators/sales-invoice.validator'

const actor = { userId: 0, requestId: 'demo-negative', ip: '127.0.0.1' }
const expectReject = async (label: string, work: () => Promise<unknown>) => {
  try {
    await work()
    throw new Error(`${label} tidak ditolak`)
  } catch (error) {
    if (error instanceof Error && error.message === `${label} tidak ditolak`) throw error
    console.info(`✓ Safety validation: ${label} correctly rejected`)
  }
}

export async function runDemoNegativeTests() {
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT
    (SELECT id FROM users WHERE email='demo.admin@finora.local') user_id,
    (SELECT id FROM accounts WHERE company_id=1 AND code='1000') header_id,
    (SELECT id FROM accounts WHERE company_id=1 AND code='1101') cash_id,
    (SELECT id FROM customers WHERE company_id=1 AND code='CUST-DEMO-010') inactive_customer_id,
    (SELECT id FROM suppliers WHERE company_id=1 AND code='SUP-DEMO-001') supplier_id,
    (SELECT id FROM items WHERE company_id=1 AND sku='ITEM-DEMO-016') service_item_id,
    (SELECT id FROM items WHERE company_id=1 AND sku='ITEM-DEMO-001') inventory_item_id,
    (SELECT unit_id FROM items WHERE company_id=1 AND sku='ITEM-DEMO-016') service_unit_id,
    (SELECT unit_id FROM items WHERE company_id=1 AND sku='ITEM-DEMO-001') inventory_unit_id,
    (SELECT id FROM warehouses WHERE company_id=1 AND code='WH-DEMO-01') warehouse_id,
    (SELECT id FROM accounts WHERE company_id=1 AND code='4102') revenue_id,
    (SELECT id FROM accounts WHERE company_id=1 AND code='6108') expense_id`)
  const ids = rows[0]!
  actor.userId = Number(ids.user_id)
  const journals = new JournalService(),
    sales = new SalesInvoiceService(),
    purchases = new PurchaseInvoiceService()
  await expectReject('posting journal imbalance', () =>
    journals.create(
      1,
      journalSchema.parse({
        journal_date: '2026-09-20',
        reference: 'NEG-IMBALANCE',
        description: 'Invalid imbalance',
        lines: [
          { accountId: Number(ids.cash_id), debit: '1000', credit: '0' },
          { accountId: Number(ids.expense_id), debit: '0', credit: '999' },
        ],
      }),
      actor,
    ),
  )
  await expectReject('posting ke header account', () =>
    journals.create(
      1,
      journalSchema.parse({
        journal_date: '2026-09-20',
        reference: 'NEG-HEADER',
        description: 'Invalid header',
        lines: [
          { accountId: Number(ids.header_id), debit: '1000', credit: '0' },
          { accountId: Number(ids.cash_id), debit: '0', credit: '1000' },
        ],
      }),
      actor,
    ),
  )
  await expectReject('sales invoice customer inactive', () =>
    sales.create(
      1,
      salesInvoiceSchema.parse({
        invoice_date: '2026-09-20',
        due_date: '2026-09-30',
        customer_id: Number(ids.inactive_customer_id),
        reference: 'NEG-INACTIVE-CUSTOMER',
        lines: [
          {
            item_id: Number(ids.service_item_id),
            unit_id: Number(ids.service_unit_id),
            quantity: '1',
            unit_price: '1000',
            revenue_account_id: Number(ids.revenue_id),
          },
        ],
      }),
      actor,
    ),
  )
  await expectReject('purchase invoice supplier invalid', () =>
    purchases.create(
      1,
      purchaseInvoiceSchema.parse({
        supplier_invoice_number: 'NEG-SUPPLIER',
        invoice_date: '2026-09-20',
        due_date: '2026-09-30',
        supplier_id: 999999999,
        reference: 'NEG-SUPPLIER',
        lines: [
          {
            item_id: Number(ids.service_item_id),
            unit_id: Number(ids.service_unit_id),
            quantity: '1',
            unit_price: '1000',
            expense_account_id: Number(ids.expense_id),
          },
        ],
      }),
      actor,
    ),
  )
  await expectReject('duplicate purchase invoice', () =>
    purchases.create(
      1,
      purchaseInvoiceSchema.parse({
        supplier_invoice_number: 'PUR-DEMO-001',
        invoice_date: '2026-09-20',
        due_date: '2026-09-30',
        supplier_id: Number(ids.supplier_id),
        reference: 'NEG-DUPLICATE',
        lines: [
          {
            item_id: Number(ids.service_item_id),
            unit_id: Number(ids.service_unit_id),
            quantity: '1',
            unit_price: '1000',
            expense_account_id: Number(ids.expense_id),
          },
        ],
      }),
      actor,
    ),
  )
  await expectReject('closed accounting period', () =>
    journals.create(
      1,
      journalSchema.parse({
        journal_date: '2025-12-20',
        reference: 'NEG-CLOSED-PERIOD',
        description: 'Invalid period',
        lines: [
          { accountId: Number(ids.expense_id), debit: '1000', credit: '0' },
          { accountId: Number(ids.cash_id), debit: '0', credit: '1000' },
        ],
      }),
      actor,
    ),
  )
  await expectReject('stock tidak cukup', () =>
    transaction((connection) =>
      new InventoryCostingService().applyMovement(connection, {
        companyId: 1,
        itemId: Number(ids.inventory_item_id),
        warehouseId: Number(ids.warehouse_id),
        direction: 'out',
        quantity: '999999',
        transactionType: 'demo_negative',
        transactionId: 1,
        transactionNumber: 'NEG-STOCK',
        movementDate: '2026-09-20',
        postingKey: 'demo-negative-stock',
        userId: actor.userId,
      }),
    ),
  )
}

if (import.meta.main) {
  try {
    await runDemoNegativeTests()
  } finally {
    await db.end()
  }
}
