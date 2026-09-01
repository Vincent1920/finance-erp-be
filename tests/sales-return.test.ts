import { describe, expect, test } from 'bun:test'
import { salesReturnSchema } from '../validators/sales-return.validator'
import { SalesReturnRepository } from '../repositories/SalesReturnRepository'
import type { QueryExecutor } from '../types/database'
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

  test('keeps sales return line SQL placeholders aligned', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = []
    const connection = {
      execute: async (sql: string, values: unknown[]) => {
        calls.push({ sql, values })
        return [{ insertId: 99 }]
      },
    } as unknown as QueryExecutor
    await new SalesReturnRepository().insert(
      connection,
      {
        companyId: 1, number: 'RET-1', date: '2026-09-01', invoiceId: 1,
        customerId: 1, warehouseId: 1, reference: 'RET-1', currency: 'IDR',
        exchangeRate: '1', subtotal: '100', discount: '0', tax: '0',
        grandTotal: '100', baseGrandTotal: '100', reason: 'Demo', userId: 1,
      },
      [{
        invoiceLineId: 1, itemId: 1, description: 'Item', quantity: '1', unitId: 1,
        unitPrice: '100', discount: '0', taxCodeId: null, taxRate: '0', taxAmount: '0',
        subtotal: '100', baseSubtotal: '100', cogsAmount: '50', reason: 'Return',
      }],
    )
    expect(calls[1]?.sql.match(/\?/g)?.length).toBe(calls[1]?.values.length)
    expect(calls[1]?.values).toHaveLength(16)
  })
})
