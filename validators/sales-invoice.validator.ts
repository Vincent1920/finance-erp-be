import { z } from 'zod'
import { currencySchema, exchangeRateSchema, isoDateSchema, moneySchema, optionalIdSchema, percentageSchema, positiveIdSchema, quantitySchema } from './common.validator'

const line = z.object({
  item_id: positiveIdSchema,
  description: z.string().trim().max(255).nullable().optional(),
  quantity: quantitySchema,
  unit_id: optionalIdSchema,
  unit_price: moneySchema,
  discount: moneySchema.default('0.00'),
  discount_percent: percentageSchema.default('0.0000'),
  tax_code_id: optionalIdSchema,
  revenue_account_id: optionalIdSchema,
}).refine((value) => value.discount === '0.00' || value.discount_percent === '0.0000', {
  message: 'Gunakan nilai diskon atau persentase diskon, bukan keduanya',
})

export const salesInvoiceSchema = z.object({
  invoice_date: isoDateSchema,
  due_date: isoDateSchema,
  customer_id: positiveIdSchema,
  warehouse_id: optionalIdSchema,
  reference: z.string().trim().max(100).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  currency: currencySchema.default('IDR'),
  exchange_rate: exchangeRateSchema.default('1.00000000'),
  lines: z.array(line).min(1).max(500),
}).refine((value) => value.due_date >= value.invoice_date, {
  path: ['due_date'], message: 'Tanggal jatuh tempo tidak boleh sebelum tanggal invoice',
})

export const salesInvoiceUpdateSchema = salesInvoiceSchema.and(z.object({ version: z.coerce.number().int().positive() }))
export const salesInvoiceListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1), limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  status: z.enum(['draft','pending_approval','approved','rejected','posted','partially_paid','paid','reversed','cancelled']).optional(),
  customer_id: positiveIdSchema.optional(), date_from: isoDateSchema.optional(), date_to: isoDateSchema.optional(),
  sort: z.enum(['invoice_date','invoice_number','due_date','grand_total','status','created_at']).default('invoice_date'),
  order: z.enum(['asc','desc']).default('desc'),
})
export const salesInvoiceReasonSchema = z.object({ reason: z.string().trim().min(3).max(1000) })
export const salesInvoiceReverseSchema = salesInvoiceReasonSchema.extend({ date: isoDateSchema })
export const salesInvoiceIdSchema = positiveIdSchema
export type SalesInvoiceInput = z.output<typeof salesInvoiceSchema>
export type SalesInvoiceUpdateInput = z.output<typeof salesInvoiceUpdateSchema>
