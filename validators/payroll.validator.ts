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
})
export const payrollRunSchema = z.object({
  period: payrollPeriodSchema,
  pay_date: z.iso.date(),
  notes: z.string().trim().max(1000).nullable().optional(),
})
export const payrollEntryUpdateSchema = z
  .object({
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
