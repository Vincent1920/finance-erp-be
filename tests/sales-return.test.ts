import { describe, expect, test } from 'bun:test'
import { salesReturnSchema } from '../validators/sales-return.validator'
describe('sales return validation', () => {
  test('accepts invoice-linked return lines', () =>
    expect(
      salesReturnSchema.safeParse({
        return_date: '2026-09-01',
        sales_invoice_id: 1,
        reason: 'Barang rusak',
        lines: [{ sales_invoice_line_id: 2, quantity: 1 }],
      }).success,
    ).toBeTrue())
  test('rejects zero quantity and short reason', () =>
    expect(
      salesReturnSchema.safeParse({
        return_date: '2026-09-01',
        sales_invoice_id: 1,
        reason: 'x',
        lines: [{ sales_invoice_line_id: 2, quantity: 0 }],
      }).success,
    ).toBeFalse())
})
