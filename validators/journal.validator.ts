import { z } from 'zod'
export const journalSchema = z.object({
  journal_number: z.string().min(3),
  journal_date: z.iso.date(),
  reference: z.string().max(100).optional(),
  description: z.string().min(3),
  lines: z
    .array(
      z.object({
        accountId: z.number().int().positive(),
        description: z.string().optional(),
        debit: z.number().nonnegative(),
        credit: z.number().nonnegative(),
      }),
    )
    .min(2),
})
