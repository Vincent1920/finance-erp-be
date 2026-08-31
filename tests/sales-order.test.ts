import { describe, expect, test } from 'bun:test'

import {
  salesOrderConversionSchema,
  salesOrderSchema,
  salesOrderUpdateSchema,
} from '../validators/sales.validator'

const validOrder = {
  order_date: '2026-09-01',
  customer_id: 1,
  warehouse_id: 1,
  payment_term_days: 30,
  expected_date: '2026-09-08',
  currency: 'IDR',
  exchange_rate: 1,
  lines: [{
    item_id: 1,
    unit_id: 1,
    quantity: 2,
    unit_price: 125_000,
    discount_amount: 0,
    discount_percent: 10,
    tax_code_id: 1,
  }],
}

describe('sales order validation', () => {
  test('normalizes a valid sales order payload', () => {
    const result = salesOrderSchema.parse(validOrder)
    expect(result.currency).toBe('IDR')
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0]?.quantity).toBe('2.0000')
    expect(result.lines[0]?.unit_price).toBe('125000.00')
  })

  test('rejects an expected date before the order date', () => {
    const result = salesOrderSchema.safeParse({ ...validOrder, expected_date: '2026-08-31' })
    expect(result.success).toBeFalse()
  })

  test('rejects simultaneous fixed and percentage discounts', () => {
    const result = salesOrderSchema.safeParse({
      ...validOrder,
      lines: [{ ...validOrder.lines[0], discount_amount: 10_000 }],
    })
    expect(result.success).toBeFalse()
  })

  test('requires optimistic concurrency version on update', () => {
    expect(salesOrderUpdateSchema.safeParse(validOrder).success).toBeFalse()
    expect(salesOrderUpdateSchema.safeParse({ ...validOrder, version: 2 }).success).toBeTrue()
  })

  test('accepts a partial conversion and rejects zero quantity', () => {
    const valid = salesOrderConversionSchema.safeParse({
      invoice_date: '2026-09-01',
      lines: [{ sales_order_line_id: 10, quantity: 1.5 }],
    })
    const invalid = salesOrderConversionSchema.safeParse({
      invoice_date: '2026-09-01',
      lines: [{ sales_order_line_id: 10, quantity: 0 }],
    })
    expect(valid.success).toBeTrue()
    expect(invalid.success).toBeFalse()
  })
})
