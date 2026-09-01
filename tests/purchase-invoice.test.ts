import { describe, expect, test } from 'bun:test'
import {
  purchaseInvoiceListQuerySchema,
  purchaseInvoiceSchema,
  purchaseInvoiceUpdateSchema,
} from '../validators/purchase-invoice.validator'

describe('purchase invoice validation', () => {
  const payload = {
    supplier_invoice_number: 'SUP-INV-001',
    invoice_date: '2026-09-01',
    due_date: '2026-09-30',
    supplier_id: 1,
    warehouse_id: 1,
    currency: 'IDR',
    exchange_rate: 1,
    lines: [
      {
        item_id: 1,
        quantity: 2,
        unit_id: 1,
        unit_price: 100,
        discount: 0,
        discount_percent: 0,
        tax_code_id: null,
      },
    ],
  }
  test('accepts a valid draft payload', () => {
    expect(purchaseInvoiceSchema.parse(payload)).toMatchObject({
      supplier_invoice_number: 'SUP-INV-001',
      currency: 'IDR',
    })
  })
  test('rejects due date before invoice date and simultaneous discounts', () => {
    expect(() => purchaseInvoiceSchema.parse({ ...payload, due_date: '2026-08-31' })).toThrow()
    expect(() =>
      purchaseInvoiceSchema.parse({
        ...payload,
        lines: [{ ...payload.lines[0], discount: 10, discount_percent: 10 }],
      }),
    ).toThrow()
  })
  test('requires optimistic version and normalizes list pagination', () => {
    expect(() => purchaseInvoiceUpdateSchema.parse(payload)).toThrow()
    expect(purchaseInvoiceListQuerySchema.parse({})).toMatchObject({
      page: 1,
      limit: 20,
      sort: 'invoice_date',
      order: 'desc',
    })
  })
})
