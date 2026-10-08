import { z } from 'zod'
import {
  isoDateSchema,
  moneySchema,
  positiveIdSchema,
  positiveMoneySchema,
} from './common.validator'

export const holdingSchema = z.object({
  effective_date: isoDateSchema,
  shares: z.coerce.number().int().min(0).max(1_000_000_000),
  nominal_value: moneySchema,
  reason: z.string().trim().min(3).max(1000),
})
export const shareholderSchema = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(2).max(191),
  email: z.email().or(z.literal('')).optional(),
  notes: z.string().trim().max(1000).optional(),
  holding: holdingSchema,
})
export const shareholderUpdateSchema = shareholderSchema
  .omit({ holding: true, code: true })
  .extend({
    version: positiveIdSchema,
    is_active: z.boolean(),
  })
export const holdingCreateSchema = holdingSchema.extend({ version: positiveIdSchema })
export const equityTransactionSchema = z
  .object({
    request_key: z.uuid(),
    shareholder_id: positiveIdSchema,
    transaction_date: isoDateSchema,
    transaction_type: z.enum(['contribution', 'opening_detail', 'dividend']),
    amount: positiveMoneySchema,
    equity_account_id: positiveIdSchema.optional(),
    counterpart_account_id: positiveIdSchema.optional(),
    journal_id: positiveIdSchema.optional(),
    reference: z.string().trim().max(100).optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.transaction_type === 'opening_detail' && !input.journal_id)
      ctx.addIssue({
        code: 'custom',
        path: ['journal_id'],
        message: 'Pilih jurnal modal yang sudah diposting',
      })
    if (input.transaction_type === 'contribution' && !input.counterpart_account_id)
      ctx.addIssue({
        code: 'custom',
        path: ['counterpart_account_id'],
        message: 'Pilih rekening atau akun aset penerima',
      })
  })
export const equityRangeSchema = z
  .object({ date_from: isoDateSchema, date_to: isoDateSchema })
  .refine(
    (input) => input.date_from <= input.date_to,
    'Tanggal mulai harus sebelum atau sama dengan tanggal akhir',
  )
