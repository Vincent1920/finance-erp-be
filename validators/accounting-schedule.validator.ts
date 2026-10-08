import { z } from 'zod'
import { isoDateSchema, positiveIdSchema } from './common.validator'

export const accountingScheduleSchema = z
  .object({
    schedule_type: z.enum(['accrual', 'prepayment']),
    name: z.string().trim().min(3).max(191),
    description: z.string().trim().max(2000).nullable().optional(),
    reference: z.string().trim().max(100).nullable().optional(),
    start_date: isoDateSchema,
    periods_count: z.coerce.number().int().min(1).max(120),
    total_estimated_amount: z.coerce.number().positive().max(999999999999999),
    materiality_threshold: z.coerce.number().min(0).max(999999999999999).default(0),
    pnl_account_id: positiveIdSchema,
    balance_sheet_account_id: positiveIdSchema,
    auto_reverse: z.boolean().default(false),
    auto_submit: z.boolean().default(true),
    save_as_template: z.boolean().default(false),
    template_name: z.string().trim().min(3).max(191).nullable().optional(),
  })
  .superRefine((value, context) => {
    if (value.save_as_template && !value.template_name)
      context.addIssue({
        code: 'custom',
        path: ['template_name'],
        message: 'Nama template wajib diisi',
      })
  })

export const scheduleGenerateSchema = z.object({ as_of_date: isoDateSchema })
export const scheduleReconcileSchema = z.object({
  actual_amount: z.coerce.number().min(0).max(999999999999999),
  actual_reference: z.string().trim().max(100).nullable().optional(),
  actual_journal_id: positiveIdSchema.nullable().optional(),
  actual_line_id: positiveIdSchema.nullable().optional(),
  source_mode: z
    .enum(['observation', 'expense_after_reversal', 'variance_adjustment'])
    .default('observation'),
})
export const accountingScheduleIdSchema = positiveIdSchema
export const scheduleAdjustmentSchema = z.object({
  date: isoDateSchema,
  actual_amount: z.coerce.number().finite().min(0).max(999999999999999),
  reference: z.string().trim().min(3).max(100),
})
