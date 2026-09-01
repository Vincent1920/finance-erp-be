import { z } from 'zod'
import { isoDateSchema, positiveIdSchema, quantitySchema } from './common.validator'
export const goodsReceiptSchema = z.object({
  receipt_date: isoDateSchema,
  purchase_order_id: positiveIdSchema,
  supplier_delivery_number: z.string().trim().max(100).nullable().optional(),
  reference: z.string().trim().max(100).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  lines: z
    .array(z.object({ purchase_order_line_id: positiveIdSchema, quantity: quantitySchema }))
    .min(1)
    .max(500),
})
export const goodsReceiptListSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  status: z.enum(['draft', 'posted', 'reversed', 'cancelled']).optional(),
})
export const goodsReceiptReasonSchema = z.object({ reason: z.string().trim().min(3).max(1000) })
export const goodsReceiptReverseSchema = goodsReceiptReasonSchema.extend({ date: isoDateSchema })
export const goodsReceiptIdSchema = positiveIdSchema
export type GoodsReceiptInput = z.output<typeof goodsReceiptSchema>
