import { z } from 'zod'

export const taxPeriodSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Masa pajak harus YYYY-MM')
export const taxTypeSchema = z.enum([
  'ppn_output',
  'ppn_input',
  'pph',
  'pph21_employee',
  'pph21_non_employee',
  'pph23',
  'pph42',
])

export const taxReconciliationQuerySchema = z.object({
  period: taxPeriodSchema,
  scope: z.enum(['all', 'pph21', 'ppn', 'unification']).default('all'),
})

const reportRowSchema = z.object({
  tax_type: taxTypeSchema,
  document_number: z.string().trim().min(1).max(100),
  document_date: z.iso.date(),
  counterparty_tax_number: z.string().trim().max(30).nullable().optional(),
  counterparty_name: z.string().trim().max(191).nullable().optional(),
  tax_code: z.string().trim().max(50).nullable().optional(),
  dpp: z.coerce.number().finite(),
  tax_amount: z.coerce.number().finite(),
  description: z.string().trim().max(500).nullable().optional(),
})

export const taxReportImportSchema = z.object({
  period: taxPeriodSchema,
  revision: z.coerce.number().int().min(0).max(999).default(0),
  source_file: z.string().trim().min(1).max(255),
  notes: z.string().trim().max(2000).default(''),
  rows: z.array(reportRowSchema).min(1).max(20_000),
})

export const taxResolutionSchema = z.object({
  period: taxPeriodSchema,
  match_key: z.string().trim().min(1).max(255),
  resolution_code: z.enum([
    'pending',
    'timing',
    'non_taxable',
    'return_or_cancel',
    'data_correction',
    'spt_correction',
    'accepted_difference',
  ]),
  note: z.string().trim().max(1000).default(''),
})

export const taxPeriodStatusSchema = z.object({
  period: taxPeriodSchema,
  status: z.enum(['open', 'reviewed', 'locked']),
})

export const taxDocumentLinkSchema = z.object({
  source_key: z.string().trim().min(1).max(100),
  tax_document_number: z.string().trim().min(1).max(100),
  tax_document_date: z.iso.date().nullable().optional(),
  notes: z.string().trim().max(500).default(''),
})

export type TaxReportImportInput = z.output<typeof taxReportImportSchema>
export type TaxResolutionInput = z.output<typeof taxResolutionSchema>
export type TaxDocumentLinkInput = z.output<typeof taxDocumentLinkSchema>
export const taxAmendmentSchema = z.object({
  period: taxPeriodSchema,
  reason: z.string().trim().min(10).max(1000),
})
export const taxPaymentSchema = z.object({
  period: taxPeriodSchema,
  tax_group: z.enum(['ppn', 'pph21', 'unification']),
  date: z.iso.date(),
  ntpn: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{16}$/, 'NTPN harus 16 karakter huruf/angka tanpa spasi'),
  journal_id: z.coerce.number().int().positive(),
  account_id: z.coerce.number().int().positive(),
  amount: z.coerce.number().finite().positive().max(1e15),
  notes: z.string().trim().max(500).default(''),
})
