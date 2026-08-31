import { z } from 'zod'
import { isoDateSchema, positiveIdSchema, quantitySchema } from './common.validator'
export const salesReturnSchema = z.object({
  return_date: isoDateSchema,
  sales_invoice_id: positiveIdSchema,
  reference: z.string().trim().max(100).nullable().optional(),
  reason: z.string().trim().min(3).max(5000),
  lines: z
    .array(
      z.object({
        sales_invoice_line_id: positiveIdSchema,
        quantity: quantitySchema,
        reason: z.string().trim().max(255).nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
})
export const salesReturnListSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  status: z
    .enum(['draft', 'pending_approval', 'approved', 'posted', 'rejected', 'reversed', 'cancelled'])
    .optional(),
})
export const salesReturnReasonSchema = z.object({ reason: z.string().trim().min(3).max(1000) })
export const salesReturnReverseSchema = salesReturnReasonSchema.extend({ date: isoDateSchema })
export const salesReturnIdSchema = positiveIdSchema
export type SalesReturnInput = z.output<typeof salesReturnSchema>
