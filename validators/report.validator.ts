import { z } from 'zod'

const isoDate = z.iso.date()
const optionalPositiveId = z.coerce.number().int().positive().optional()

export const dateRangeQuerySchema = z
  .object({
    date_from: isoDate,
    date_to: isoDate,
  })
  .refine((value) => value.date_from <= value.date_to, {
    message: 'date_from tidak boleh setelah date_to',
    path: ['date_to'],
  })

export const asOfQuerySchema = z.object({ as_of_date: isoDate })

export const reconciliationDetailQuerySchema = z.object({
  as_of_date: isoDate,
  reconciliation_type: z.enum(['ar', 'ap', 'inventory', 'bank', 'fixed_asset', 'accumulated_depreciation', 'payroll']),
  account_id: z.coerce.number().int().positive(),
})

export const reconciliationCaseSchema = z.object({
  as_of_date: isoDate,
  reconciliation_type: z.enum(['ar', 'ap', 'inventory', 'bank', 'fixed_asset', 'accumulated_depreciation', 'payroll']),
  account_id: z.coerce.number().int().positive(),
  general_ledger: z.coerce.number().finite(),
  subledger: z.coerce.number().finite(),
  difference: z.coerce.number().finite(),
  status: z.enum(['open', 'in_review', 'resolved', 'accepted_variance']),
  assigned_to: z.coerce.number().int().positive().nullable().optional(),
  due_date: isoDate.nullable().optional(),
  note: z.string().trim().max(5000).nullable().optional(),
}).superRefine((value, context) => {
  if (['resolved', 'accepted_variance'].includes(value.status) && !value.note) {
    context.addIssue({ code: 'custom', path: ['note'], message: 'Catatan penyelesaian wajib diisi' })
  }
})

export const generalLedgerQuerySchema = dateRangeQuerySchema.and(
  z.object({
    account_id: optionalPositiveId,
    cost_center_id: optionalPositiveId,
    project_id: optionalPositiveId,
    reference: z.string().trim().max(100).optional(),
    page: z.string().optional(),
    limit: z.string().optional(),
  }),
)

export const inventoryReportQuerySchema = z.object({ as_of_date: isoDate.optional() })

export const budgetActualQuerySchema = dateRangeQuerySchema.and(
  z.object({
    account_id: optionalPositiveId,
    cost_center_id: optionalPositiveId,
    project_id: optionalPositiveId,
  }),
)
