import { z } from 'zod'
import { journalLineSchema } from './journal.validator'
import {
  currencySchema,
  exchangeRateSchema,
  isoDateSchema,
  positiveIdSchema,
} from './common.validator'

export const recurringJournalSchema = z
  .object({
    name: z.string().trim().min(3).max(191),
    description: z.string().trim().max(2000).nullable().optional(),
    reference: z.string().trim().max(100).nullable().optional(),
    frequency: z.enum(['monthly', 'quarterly', 'yearly', 'custom']),
    interval_value: z.coerce.number().int().min(1).max(120).default(1),
    interval_unit: z.enum(['day', 'week', 'month', 'year']).nullable().optional(),
    start_date: isoDateSchema,
    end_date: isoDateSchema.nullable().optional(),
    currency: currencySchema.default('IDR'),
    exchange_rate: exchangeRateSchema.default('1'),
    auto_submit: z.boolean().default(false),
    lines: z.array(journalLineSchema).min(2).max(500),
  })
  .superRefine((value, context) => {
    if (value.frequency === 'custom' && !value.interval_unit)
      context.addIssue({
        code: 'custom',
        path: ['interval_unit'],
        message: 'Satuan interval wajib dipilih untuk jadwal khusus',
      })
    if (value.end_date && value.end_date < value.start_date)
      context.addIssue({
        code: 'custom',
        path: ['end_date'],
        message: 'Tanggal selesai tidak boleh sebelum tanggal mulai',
      })
  })

export const recurringJournalUpdateSchema = recurringJournalSchema.extend({
  version: z.coerce.number().int().positive(),
})

export const recurringGenerateSchema = z.object({
  as_of_date: isoDateSchema,
})

export const recurringActiveSchema = z.object({ active: z.boolean() })

export const recurringIdSchema = positiveIdSchema
