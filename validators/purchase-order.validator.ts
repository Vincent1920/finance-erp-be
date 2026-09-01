import { z } from 'zod'
import {
  currencySchema,
  exchangeRateSchema,
  isoDateSchema,
  moneySchema,
  optionalIdSchema,
  percentageSchema,
  positiveIdSchema,
  quantitySchema,
} from './common.validator'

const line = z
  .object({
    item_id: positiveIdSchema,
    description: z.string().trim().max(255).nullable().optional(),
    quantity: quantitySchema,
    unit_id: optionalIdSchema,
    unit_price: moneySchema,
    discount_amount: moneySchema.default('0.00'),
    discount_percent: percentageSchema.default('0.0000'),
    tax_code_id: optionalIdSchema,
  })
  .refine((value) => value.discount_amount === '0.00' || value.discount_percent === '0.0000', {
    message: 'Gunakan nilai diskon atau persentase diskon, bukan keduanya',
  })

export const purchaseOrderSchema = z
  .object({
    order_date: isoDateSchema,
    supplier_id: positiveIdSchema,
    warehouse_id: positiveIdSchema,
    buyer_id: optionalIdSchema,
    payment_term_days: z.coerce.number().int().min(0).max(3650).default(0),
    expected_date: isoDateSchema.nullable().optional(),
    supplier_reference: z.string().trim().max(100).nullable().optional(),
    currency: currencySchema.default('IDR'),
    exchange_rate: exchangeRateSchema.default('1.00000000'),
    notes: z.string().trim().max(5000).nullable().optional(),
    lines: z.array(line).min(1).max(500),
  })
  .refine((value) => !value.expected_date || value.expected_date >= value.order_date, {
    path: ['expected_date'],
    message: 'Tanggal penerimaan tidak boleh sebelum tanggal order',
  })

export const purchaseOrderUpdateSchema = purchaseOrderSchema.and(
  z.object({ version: z.coerce.number().int().positive() }),
)
export const purchaseOrderListSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  status: z
    .enum([
      'draft',
      'confirmed',
      'partially_received',
      'partially_billed',
      'completed',
      'cancelled',
    ])
    .optional(),
  supplier_id: positiveIdSchema.optional(),
  date_from: isoDateSchema.optional(),
  date_to: isoDateSchema.optional(),
  sort: z
    .enum(['order_date', 'order_number', 'grand_total', 'status', 'created_at'])
    .default('order_date'),
  order: z.enum(['asc', 'desc']).default('desc'),
})
export const purchaseOrderReasonSchema = z.object({ reason: z.string().trim().min(3).max(1000) })
export const purchaseOrderIdSchema = positiveIdSchema
export type PurchaseOrderInput = z.output<typeof purchaseOrderSchema>
export type PurchaseOrderUpdateInput = z.output<typeof purchaseOrderUpdateSchema>
