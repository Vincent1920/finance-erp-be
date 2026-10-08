import { z } from 'zod'

const money = z.coerce.number().finite().min(0).max(999_999_999_999)
export const payrollPeriodSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Periode harus YYYY-MM')
export const payrollEmployeeSchema = z.object({
  employee_number: z.string().trim().min(1).max(40),
  name: z.string().trim().min(2).max(191),
  nik: z
    .string()
    .trim()
    .regex(/^\d{16}$/, 'NIK wajib 16 digit')
    .nullable()
    .optional(),
  npwp: z
    .string()
    .trim()
    .regex(/^\d{16}$/, 'NPWP wajib 16 digit')
    .nullable()
    .optional(),
  email: z.string().trim().email().nullable().optional(),
  department_id: z.coerce.number().int().positive().nullable().optional(),
  department: z.string().trim().max(100).nullable().optional(),
  position: z.string().trim().max(100).nullable().optional(),
  employment_type: z.enum(['permanent', 'contract', 'non_employee']).default('permanent'),
  ptkp_status: z.string().trim().max(10).default('TK/0'),
  ter_category: z.enum(['A', 'B', 'C']).default('A'),
  hire_date: z.iso.date(),
  termination_date: z.iso.date().nullable().optional(),
  bank_name: z.string().trim().max(100).nullable().optional(),
  bank_account_number: z.string().trim().max(100).nullable().optional(),
  bank_account_name: z.string().trim().max(191).nullable().optional(),
  bpjs_health_number: z.string().trim().max(50).nullable().optional(),
  bpjs_employment_number: z.string().trim().max(50).nullable().optional(),
  basic_salary: money,
  fixed_allowance: money,
  is_active: z.boolean().default(true),
  salary_effective_from: z.iso.date().optional(),
  salary_change_reason: z
    .string()
    .trim()
    .max(500)
    .optional()
    .refine((value) => !value || value.length >= 5, 'Alasan perubahan minimal 5 karakter')
    .transform((value) => value || undefined),
})
export const payrollEmployeeStatusSchema = z.object({
  is_active: z.boolean(),
  effective_date: z.iso.date().nullable().optional(),
  reason: z.string().trim().min(5, 'Alasan perubahan status minimal 5 karakter').max(500),
}).superRefine((value, context) => {
  if (!value.is_active && !value.effective_date)
    context.addIssue({ code: 'custom', path: ['effective_date'], message: 'Tanggal berhenti wajib diisi' })
})
export const payrollProrationSchema = z.object({
 proration_method:z.enum(['none','calendar','working_days']).default('none'),
 working_weekdays:z.string().regex(/^[0-6](,[0-6])*$/).refine(v=>new Set(v.split(',')).size===v.split(',').length,'Hari kerja tidak boleh duplikat').default('1,2,3,4,5'),
 prorate_bpjs:z.boolean().default(false),
})
export const payrollRunSchema = z.object({
  period: payrollPeriodSchema,
  pay_date: z.iso.date(),
  notes: z.string().trim().max(1000).nullable().optional(),
})
export const payrollEntryUpdateSchema = z
  .object({
    custom_components: z.array(z.object({ id: z.coerce.number().int().positive().optional(), component_id: z.coerce.number().int().positive(), amount: money.default(0), taxable_amount: money.nullable().optional(), tax_note: z.string().trim().max(500).optional(), source_reference: z.string().trim().max(191).nullable().optional() })).max(100).optional(),
    reimbursement_taxable: z.boolean().optional(),
    absence_reduces_tax: z.boolean().optional(),
    variable_allowance: money.optional(),
    overtime: money.optional(),
    bonus: money.optional(),
    thr: money.optional(),
    rapel: money.optional(),
    reimbursement: money.optional(),
    absence_deduction: money.optional(),
    loan_deduction: money.optional(),
    other_deduction: money.optional(),
    pph21_override: money.nullable().optional(),
    pph21_override_reason: z.string().trim().max(500).nullable().optional(),
  })
  .refine((value) => value.pph21_override == null || Boolean(value.pph21_override_reason), {
    message: 'Alasan koreksi PPh 21 wajib diisi',
    path: ['pph21_override_reason'],
  })
export const payrollPolicySchema = z
  .object({
    effective_from: z.iso.date(),
    health_employee_rate: z.coerce.number().min(0).max(1),
    health_employer_rate: z.coerce.number().min(0).max(1),
    health_wage_cap: money,
    health_wage_floor: money.default(0),
    jht_employee_rate: z.coerce.number().min(0).max(1),
    jht_employer_rate: z.coerce.number().min(0).max(1),
    jp_employee_rate: z.coerce.number().min(0).max(1),
    jp_employer_rate: z.coerce.number().min(0).max(1),
    jp_wage_cap: money,
    jkk_employer_rate: z.coerce.number().min(0).max(1),
    jkm_employer_rate: z.coerce.number().min(0).max(1),
    salary_expense_account_id: z.coerce.number().int().positive(),
    employer_bpjs_expense_account_id: z.coerce.number().int().positive(),
    health_employer_expense_account_id: z.coerce.number().int().positive().nullable().optional(),
    employment_employer_expense_account_id: z.coerce.number().int().positive().nullable().optional(),
    payroll_payable_account_id: z.coerce.number().int().positive(),
    bpjs_payable_account_id: z.coerce.number().int().positive(),
    pph21_payable_account_id: z.coerce.number().int().positive(),
    employee_loan_account_id: z.coerce.number().int().positive(),
    other_deduction_account_id: z.coerce.number().int().positive(),
    source_reference: z.string().trim().min(5, 'Sumber kebijakan wajib diisi').max(500),
    policy_notes: z.string().trim().max(1000).nullable().optional(),
  })
  .superRefine((value, context) => {
    if (value.health_wage_cap <= 0)
      context.addIssue({
        code: 'custom',
        path: ['health_wage_cap'],
        message: 'Batas maksimum upah Kesehatan harus lebih dari nol',
      })
    if (value.jp_wage_cap <= 0)
      context.addIssue({
        code: 'custom',
        path: ['jp_wage_cap'],
        message: 'Batas upah JP harus lebih dari nol',
      })
    if (value.health_wage_floor > value.health_wage_cap)
      context.addIssue({
        code: 'custom',
        path: ['health_wage_floor'],
        message: 'Batas minimum tidak boleh melebihi batas maksimum upah Kesehatan',
      })
    const controlAccountIds = [
      value.payroll_payable_account_id,
      value.bpjs_payable_account_id,
      value.pph21_payable_account_id,
      value.employee_loan_account_id,
      value.other_deduction_account_id,
    ]
    if (new Set(controlAccountIds).size !== controlAccountIds.length)
      context.addIssue({
        code: 'custom',
        path: ['payroll_payable_account_id'],
        message:
          'Akun utang gaji, BPJS, PPh 21, piutang pegawai, dan potongan lain harus dipisahkan',
      })
  })
export const payrollReopenSchema = z.object({ reason: z.string().trim().min(10).max(500) })
export const payrollPaymentSchema = z.object({
  payment_account_id: z.coerce.number().int().positive(),
  payment_date: z.iso.date(),
})
export const payrollPolicySimulationSchema = z
  .object({
    health_employee_rate: z.coerce.number().min(0).max(1),
    health_employer_rate: z.coerce.number().min(0).max(1),
    health_wage_cap: money,
    health_wage_floor: money.default(0),
    jht_employee_rate: z.coerce.number().min(0).max(1),
    jht_employer_rate: z.coerce.number().min(0).max(1),
    jp_employee_rate: z.coerce.number().min(0).max(1),
    jp_employer_rate: z.coerce.number().min(0).max(1),
    jp_wage_cap: money,
    jkk_employer_rate: z.coerce.number().min(0).max(1),
    jkm_employer_rate: z.coerce.number().min(0).max(1),
  })
  .refine((value) => value.health_wage_floor <= value.health_wage_cap, {
    path: ['health_wage_floor'],
    message: 'Batas minimum tidak boleh melebihi batas maksimum upah Kesehatan',
  })

export const payrollComponentSchema = z.object({
 code:z.string().trim().min(1).max(40), name:z.string().trim().min(2).max(191),
 kind:z.enum(['earning','deduction']), channel:z.enum(['payroll','noncash','external_cash','external_noncash']),
 basis:z.literal('nominal'), rate:z.literal(0).default(0),
 taxable:z.boolean(), bpjs_base:z.boolean(),
 expense_account_id:z.coerce.number().int().positive().nullable(), contra_account_id:z.coerce.number().int().positive().nullable(),
 effective_from:z.iso.date(), effective_to:z.iso.date().nullable(),
 policy_reference:z.string().trim().min(5).max(500), is_active:z.boolean(), version:z.coerce.number().int().positive().optional(),
})

export const payrollRecurringSchema=z.object({employee_id:z.coerce.number().int().positive(),component_id:z.coerce.number().int().positive(),amount:money,effective_from:z.iso.date(),effective_to:z.iso.date().nullable(),prorate:z.boolean(),is_active:z.boolean(),version:z.coerce.number().int().positive().optional()})
