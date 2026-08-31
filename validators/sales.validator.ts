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

const nullableText = (max: number) => z.string().trim().max(max).nullable().optional()

const salesOrderLineSchema = z
  .object({
    item_id: positiveIdSchema,
    description: nullableText(255),
    quantity: quantitySchema,
    unit_id: optionalIdSchema,
    unit_price: moneySchema,
    discount_amount: moneySchema.default('0.00'),
    discount_percent: percentageSchema.default('0.0000'),
    tax_code_id: optionalIdSchema,
  })
  .refine(
    (line) => line.discount_amount === '0.00' || line.discount_percent === '0.0000',
    { message: 'Gunakan nilai diskon atau persentase diskon, bukan keduanya' },
  )

export const salesOrderSchema = z
  .object({
    order_date: isoDateSchema,
    customer_id: positiveIdSchema,
    warehouse_id: positiveIdSchema,
    sales_person_id: optionalIdSchema,
    payment_term_days: z.coerce.number().int().min(0).max(3650).default(0),
    expected_date: isoDateSchema.nullable().optional(),
    reference: nullableText(100),
    currency: currencySchema.default('IDR'),
    exchange_rate: exchangeRateSchema.default('1.00000000'),
    notes: nullableText(5000),
    lines: z.array(salesOrderLineSchema).min(1).max(500),
  })
  .refine((order) => !order.expected_date || order.expected_date >= order.order_date, {
    path: ['expected_date'],
    message: 'Tanggal pengiriman tidak boleh sebelum tanggal order',
  })

export const salesOrderUpdateSchema = salesOrderSchema.and(
  z.object({ version: z.coerce.number().int().positive() }),
)

export const salesOrderListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  status: z
    .enum(['draft', 'confirmed', 'partially_invoiced', 'invoiced', 'cancelled'])
    .optional(),
  customer_id: positiveIdSchema.optional(),
  date_from: isoDateSchema.optional(),
  date_to: isoDateSchema.optional(),
  sort: z.enum(['order_date', 'order_number', 'grand_total', 'status', 'created_at']).default('order_date'),
  order: z.enum(['asc', 'desc']).default('desc'),
})

export const salesOrderIdSchema = positiveIdSchema
export const salesOrderCancelSchema = z.object({ reason: z.string().trim().min(3).max(1000) })
export const salesOrderConversionSchema = z.object({
  invoice_date: isoDateSchema,
  lines: z
    .array(
      z.object({
        sales_order_line_id: positiveIdSchema,
        quantity: quantitySchema,
      }),
    )
    .min(1)
    .max(500)
    .optional(),
})

export type SalesOrderInput = z.output<typeof salesOrderSchema>
export type SalesOrderUpdateInput = z.output<typeof salesOrderUpdateSchema>
export type SalesOrderConversionInput = z.output<typeof salesOrderConversionSchema>
