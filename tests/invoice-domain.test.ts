import { describe, expect, test } from 'bun:test'

import { InvoiceRepository, type InvoiceLineWrite } from '../repositories/InvoiceRepository'
import type { QueryExecutor } from '../types/database'
import { ValidationError } from '../utils/AppError'
import {
  calculateInvoiceLine,
  calculateInvoiceTotals,
  importedPurchaseInvoiceSchema,
  importedSalesInvoiceSchema,
  importedStatus,
} from '../services/InvoiceDomainSupport'

describe('invoice domain calculations', () => {
  test('calculates discounts, tax, exchange rate, and totals without floating point drift', () => {
    const first = calculateInvoiceLine({
      quantity: '1.5000',
      unitPrice: '100.00',
      discount: '10.00',
      taxRate: '11.0000',
      exchangeRate: '2.00000000',
    })
    const second = calculateInvoiceLine({
      quantity: '2.0000',
      unitPrice: '25.00',
      discountPercent: '10.0000',
      exchangeRate: '2.00000000',
    })

    expect(first).toMatchObject({
      grossAmount: '150.00',
      discount: '10.00',
      subtotal: '140.00',
      taxAmount: '15.40',
      grandTotal: '155.40',
      baseSubtotal: '280.00',
      baseTaxAmount: '30.80',
    })
    expect(second).toMatchObject({
      grossAmount: '50.00',
      discount: '5.00',
      subtotal: '45.00',
      grandTotal: '45.00',
    })
    expect(calculateInvoiceTotals([first, second], '2')).toEqual({
      subtotal: '200.00',
      discount: '15.00',
      tax: '15.40',
      grandTotal: '200.40',
      baseSubtotal: '400.00',
      baseDiscount: '30.00',
      baseTax: '30.80',
      baseGrandTotal: '400.80',
    })
  })

  test('rejects a discount larger than the line gross amount', () => {
    expect(() =>
      calculateInvoiceLine({ quantity: '1', unitPrice: '10', discount: '10.01' }),
    ).toThrow(ValidationError)
  })

  test('maps submitted imports to pending approval without posting', () => {
    expect(importedStatus('draft')).toBe('draft')
    expect(importedStatus('submitted')).toBe('pending_approval')
  })
})

describe('imported invoice contracts', () => {
  const line = { itemId: 1, quantity: '1', unitPrice: '100' }

  test('normalizes defaults and validates the invoice date range', () => {
    const parsed = importedSalesInvoiceSchema.parse({
      invoiceNumber: ' INV-001 ',
      invoiceDate: '2026-08-01',
      dueDate: '2026-08-31',
      customerId: 1,
      lines: [line],
    })
    expect(parsed).toMatchObject({
      invoiceNumber: 'INV-001',
      currency: 'IDR',
      exchangeRate: '1.00000000',
      importAs: 'draft',
    })

    expect(() =>
      importedPurchaseInvoiceSchema.parse({
        invoiceNumber: 'PI-001',
        invoiceDate: '2026-08-31',
        dueDate: '2026-08-01',
        supplierId: 1,
        lines: [line],
      }),
    ).toThrow()
  })
})

describe('invoice persistence contract', () => {
  test('keeps SQL placeholders aligned for both headers and lines', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = []
    const connection = {
      execute: async (sql: string, values: unknown[] = []) => {
        expect(sql.match(/\?/g)?.length ?? 0).toBe(values.length)
        calls.push({ sql, values })
        return [{ insertId: 42 }, []]
      },
    } as unknown as QueryExecutor
    const repository = new InvoiceRepository()
    const totals = {
      subtotal: '100.00',
      discount: '0.00',
      tax: '11.00',
      grandTotal: '111.00',
      baseSubtotal: '100.00',
      baseDiscount: '0.00',
      baseTax: '11.00',
      baseGrandTotal: '111.00',
    }
    const line: InvoiceLineWrite = {
      lineNumber: 1,
      itemId: 1,
      quantity: '1.0000',
      unitId: 1,
      unitPrice: '100.00',
      discount: '0.00',
      discountPercent: '0.000000',
      taxCodeId: 1,
      taxRate: '11.0000',
      taxAmount: '11.00',
      subtotal: '100.00',
      baseSubtotal: '100.00',
      baseTaxAmount: '11.00',
      accountId: 1,
    }

    await repository.insertSales(connection, {
      companyId: 1,
      invoiceNumber: 'SI-001',
      invoiceDate: '2026-08-01',
      dueDate: '2026-08-31',
      customerId: 1,
      currency: 'IDR',
      exchangeRate: '1.00000000',
      status: 'draft',
      accountingPeriodId: 1,
      userId: 1,
      totals,
      lines: [line],
    })
    await repository.insertPurchase(connection, {
      companyId: 1,
      invoiceNumber: 'PI-001',
      invoiceDate: '2026-08-01',
      dueDate: '2026-08-31',
      supplierId: 1,
      currency: 'IDR',
      exchangeRate: '1.00000000',
      status: 'pending_approval',
      accountingPeriodId: 1,
      userId: 1,
      totals,
      lines: [line],
    })

    expect(calls).toHaveLength(4)
  })
})
