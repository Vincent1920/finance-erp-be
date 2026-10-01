import { z } from 'zod'
import { positiveIdSchema } from './common.validator'

export const yearEndPreviewSchema = z
  .object({
    fiscal_year: z.coerce.number().int().min(1900).max(2200),
    current_year_earnings_account_id: positiveIdSchema,
    retained_earnings_account_id: positiveIdSchema,
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .refine(
    (value) => value.current_year_earnings_account_id !== value.retained_earnings_account_id,
    {
      path: ['retained_earnings_account_id'],
      message: 'Akun laba berjalan dan laba ditahan harus berbeda',
    },
  )

export const yearEndReverseSchema = z.object({
  reversal_date: z.iso.date(),
  reason: z.string().trim().min(10, 'Alasan pembalikan minimal 10 karakter').max(2000),
})
