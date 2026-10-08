import { z } from 'zod'
import { positiveIdSchema } from './common.validator'

export const periodCloseQuerySchema = z.object({
  year: z.coerce.number().int().min(1900).max(2200).optional(),
})

export const periodCloseValidationSchema = z.object({
  period_id: positiveIdSchema,
  requested_status: z.enum(['soft_closed', 'closed', 'locked']),
  notes: z.string().trim().max(2000).nullable().optional(),
})

export const periodReopenSchema = z.object({
  reason: z.string().trim().min(10, 'Alasan pembukaan kembali minimal 10 karakter').max(2000),
})

export const periodReopenDecisionSchema = z.object({
  notes: z.string().trim().min(5, 'Catatan keputusan minimal 5 karakter').max(2000),
})
