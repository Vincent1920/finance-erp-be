import { z } from 'zod'
import {
  isoDateSchema,
  positiveIdSchema,
  positiveMoneySchema,
  moneySchema,
} from './common.validator'
export const currencyRateSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  date: isoDateSchema,
  rate: z.coerce.number().finite().positive().max(1e10),
  source: z.string().trim().min(3).max(100),
})
export const bankTransferSchema = z
  .object({
    request_key: z.uuid(),
    date: isoDateSchema,
    from_bank_id: positiveIdSchema,
    to_bank_id: positiveIdSchema,
    from_amount: positiveMoneySchema,
    to_amount: positiveMoneySchema,
    target_rate: z.coerce.number().finite().positive().max(1e10),
    fee_amount: moneySchema.default('0.00'),
    reference: z.string().trim().min(3).max(100),
  })
  .refine((v) => v.from_bank_id !== v.to_bank_id, {
    message: 'Pilih rekening tujuan yang berbeda',
    path: ['to_bank_id'],
  })
export const bankRevalueSchema = z.object({
  request_key: z.uuid(),
  bank_id: positiveIdSchema,
  date: isoDateSchema,
  rate: z.coerce.number().finite().positive().max(1e10),
  reference: z.string().trim().min(3).max(100),
})
