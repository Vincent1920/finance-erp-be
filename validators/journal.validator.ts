import { z } from 'zod'

import { compareDecimal } from '../utils/decimal'
import {
  currencySchema,
  exchangeRateSchema,
  isoDateSchema,
  moneySchema,
  optionalIdSchema,
  positiveIdSchema,
} from './common.validator'

export const journalLineSchema = z
  .object({
    accountId: positiveIdSchema,
    description: z.string().trim().max(255).optional(),
    costCenterId: optionalIdSchema,
    projectId: optionalIdSchema,
    debit: moneySchema,
    credit: moneySchema,
  })
  .refine(
    (line) => {
      const debitPositive = compareDecimal(line.debit, '0') > 0
      const creditPositive = compareDecimal(line.credit, '0') > 0
      return debitPositive !== creditPositive
    },
    { message: 'Setiap baris harus memiliki debit atau kredit, tidak keduanya' },
  )

export const journalSchema = z.object({
  journal_date: isoDateSchema,
  reference: z.string().trim().max(100).nullable().optional(),
  description: z.string().trim().min(3).max(500),
  currency: currencySchema.default('IDR'),
  exchange_rate: exchangeRateSchema.default('1'),
  lines: z.array(journalLineSchema).min(2).max(500),
})

export const journalListQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  search: z.string().trim().max(191).optional(),
  status: z
    .enum([
      'draft',
      'pending_approval',
      'approved',
      'rejected',
      'posted',
      'reversed',
      'cancelled',
    ])
    .optional(),
  date_from: isoDateSchema.optional(),
  date_to: isoDateSchema.optional(),
  source_type: z.string().trim().max(50).optional(),
})

export const rejectionSchema = z.object({ comments: z.string().trim().min(3).max(1000) })
export const reversalSchema = z.object({
  reversal_date: isoDateSchema,
  reason: z.string().trim().min(3).max(1000),
})

export const journalIdSchema = positiveIdSchema
