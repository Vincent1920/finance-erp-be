import { z } from 'zod'

import { compareDecimal, normalizeDecimal } from '../utils/decimal'

const decimalInput = z.union([
  z.string().trim().regex(/^[+-]?\d+(?:\.\d+)?$/, 'Format angka decimal tidak valid'),
  z.number().finite(),
])

export const decimalSchema = (
  scale: number,
  options: { positive?: boolean; nonnegative?: boolean; max?: string } = {},
) =>
  decimalInput
    .transform((value, context) => {
      try {
        return normalizeDecimal(value, scale)
      } catch {
        context.addIssue({ code: 'custom', message: 'Nilai decimal tidak valid' })
        return z.NEVER
      }
    })
    .refine((value) => !options.positive || compareDecimal(value, '0', scale) > 0, {
      message: 'Nilai harus lebih dari nol',
    })
    .refine((value) => !options.nonnegative || compareDecimal(value, '0', scale) >= 0, {
      message: 'Nilai tidak boleh negatif',
    })
    .refine((value) => !options.max || compareDecimal(value, options.max, scale) <= 0, {
      message: `Nilai tidak boleh melebihi ${options.max ?? ''}`,
    })

export const moneySchema = decimalSchema(2, { nonnegative: true })
export const positiveMoneySchema = decimalSchema(2, { positive: true })
export const quantitySchema = decimalSchema(4, { positive: true })
export const nonnegativeQuantitySchema = decimalSchema(4, { nonnegative: true })
export const exchangeRateSchema = decimalSchema(8, { positive: true })
export const percentageSchema = decimalSchema(4, { nonnegative: true, max: '100' })
export const positiveIdSchema = z.coerce.number().int().positive()
export const optionalIdSchema = positiveIdSchema.nullable().optional()
export const isoDateSchema = z.iso.date()
export const currencySchema = z.string().trim().length(3).transform((value) => value.toUpperCase())

export const listQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  search: z.string().trim().max(191).optional(),
  sort: z.string().max(50).optional(),
  order: z.enum(['asc', 'desc']).optional(),
})
