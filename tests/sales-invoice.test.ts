import { describe, expect, test } from 'bun:test'
import { salesInvoiceReverseSchema, salesInvoiceSchema, salesInvoiceUpdateSchema } from '../validators/sales-invoice.validator'

const invoice = { invoice_date:'2026-09-01', due_date:'2026-09-30', customer_id:1, warehouse_id:1, currency:'IDR', exchange_rate:1, lines:[{ item_id:1, quantity:2, unit_id:1, unit_price:100000, discount:0, discount_percent:10, tax_code_id:1 }] }
describe('sales invoice validation', () => {
  test('normalizes a valid invoice', () => { const result=salesInvoiceSchema.parse(invoice); expect(result.lines[0]?.quantity).toBe('2.0000'); expect(result.lines[0]?.unit_price).toBe('100000.00') })
  test('rejects due date before invoice date', () => expect(salesInvoiceSchema.safeParse({...invoice,due_date:'2026-08-31'}).success).toBeFalse())
  test('rejects two discount modes', () => expect(salesInvoiceSchema.safeParse({...invoice,lines:[{...invoice.lines[0],discount:1000}]}).success).toBeFalse())
  test('requires version for update', () => { expect(salesInvoiceUpdateSchema.safeParse(invoice).success).toBeFalse(); expect(salesInvoiceUpdateSchema.safeParse({...invoice,version:1}).success).toBeTrue() })
  test('validates reversal date and reason', () => { expect(salesInvoiceReverseSchema.safeParse({date:'2026-09-01',reason:'Koreksi transaksi'}).success).toBeTrue(); expect(salesInvoiceReverseSchema.safeParse({date:'x',reason:'a'}).success).toBeFalse() })
})
