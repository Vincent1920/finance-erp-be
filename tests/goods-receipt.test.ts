import { describe, expect, test } from 'bun:test'
import {
  goodsReceiptReverseSchema,
  goodsReceiptSchema,
} from '../validators/goods-receipt.validator'
describe('goods receipt validation', () => {
  test('accepts partial receipt lines', () =>
    expect(
      goodsReceiptSchema.safeParse({
        receipt_date: '2026-09-01',
        purchase_order_id: 1,
        lines: [{ purchase_order_line_id: 2, quantity: 1.5 }],
      }).success,
    ).toBeTrue())
  test('rejects zero quantities', () =>
    expect(
      goodsReceiptSchema.safeParse({
        receipt_date: '2026-09-01',
        purchase_order_id: 1,
        lines: [{ purchase_order_line_id: 2, quantity: 0 }],
      }).success,
    ).toBeFalse())
  test('validates reversal contract', () =>
    expect(
      goodsReceiptReverseSchema.safeParse({ date: '2026-09-02', reason: 'Koreksi penerimaan' })
        .success,
    ).toBeTrue())
})
