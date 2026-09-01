import { describe, expect, test } from 'bun:test'
import {
  purchaseOrderSchema,
  purchaseOrderUpdateSchema,
} from '../validators/purchase-order.validator'
const order = {
  order_date: '2026-09-01',
  supplier_id: 1,
  warehouse_id: 1,
  payment_term_days: 30,
  expected_date: '2026-09-10',
  currency: 'IDR',
  exchange_rate: 1,
  lines: [
    {
      item_id: 1,
      unit_id: 1,
      quantity: 2,
      unit_price: 100000,
      discount_amount: 0,
      discount_percent: 10,
      tax_code_id: 1,
    },
  ],
}
describe('purchase order validation', () => {
  test('normalizes valid payload', () => {
    const r = purchaseOrderSchema.parse(order)
    expect(r.lines[0]?.quantity).toBe('2.0000')
    expect(r.lines[0]?.unit_price).toBe('100000.00')
  })
  test('rejects expected date before order', () =>
    expect(
      purchaseOrderSchema.safeParse({ ...order, expected_date: '2026-08-31' }).success,
    ).toBeFalse())
  test('rejects simultaneous discounts', () =>
    expect(
      purchaseOrderSchema.safeParse({
        ...order,
        lines: [{ ...order.lines[0], discount_amount: 1000 }],
      }).success,
    ).toBeFalse())
  test('requires update version', () => {
    expect(purchaseOrderUpdateSchema.safeParse(order).success).toBeFalse()
    expect(purchaseOrderUpdateSchema.safeParse({ ...order, version: 1 }).success).toBeTrue()
  })
})
