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
