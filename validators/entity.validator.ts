import { z } from 'zod'

const nullableId = z.coerce.number().int().positive().nullable().optional()
const active = z.boolean().default(true)
const code = z.string().trim().min(1).max(50)
const name = z.string().trim().min(2).max(191)
const date = z.iso.date()

export const accountingPeriodSchema = z
  .object({
    year: z.coerce.number().int().min(1900).max(2200),
    month: z.coerce.number().int().min(1).max(12),
    start_date: date,
    end_date: date,
    status: z.enum(['open', 'soft_closed', 'closed']).default('open'),
  })
  .refine((value) => value.start_date <= value.end_date, {
    message: 'Tanggal mulai harus sebelum atau sama dengan tanggal selesai',
    path: ['end_date'],
  })

export const customerSchema = z.object({
  code: code.max(30),
  name,
  tax_number: z.string().trim().max(50).nullable().optional(),
  email: z.email().nullable().optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  address: z.string().trim().max(5000).nullable().optional(),
  city: z.string().trim().max(100).nullable().optional(),
  credit_limit: z.coerce.number().nonnegative().default(0),
  payment_term_days: z.coerce.number().int().nonnegative().max(3650).default(0),
  receivable_account_id: nullableId,
  is_active: active,
})

export const supplierSchema = customerSchema
  .omit({ credit_limit: true, receivable_account_id: true })
  .extend({ payable_account_id: nullableId })

export const accountSchema = z.object({
  code: code.max(30),
  name,
  account_type: z.enum([
    'asset',
    'liability',
    'equity',
    'revenue',
    'cogs',
    'expense',
    'other_income',
    'other_expense',
  ]),
  normal_balance: z.enum(['debit', 'credit']),
  parent_id: nullableId,
  level: z.coerce.number().int().min(0).max(10).default(0),
  is_header: z.boolean().default(false),
  is_posting: z.boolean().default(true),
  is_active: active,
  allow_manual_journal: z.boolean().default(true),
})

export const itemSchema = z.object({
  sku: code,
  barcode: z.string().trim().max(100).nullable().optional(),
  name,
  description: z.string().trim().max(5000).nullable().optional(),
  item_type: z.enum(['inventory', 'service', 'non_inventory']),
  unit_id: z.coerce.number().int().positive(),
  sales_account_id: nullableId,
  inventory_account_id: nullableId,
  cogs_account_id: nullableId,
  purchase_account_id: nullableId,
  sales_price: z.coerce.number().nonnegative().default(0),
  purchase_price: z.coerce.number().nonnegative().default(0),
  average_cost: z.coerce.number().nonnegative().default(0),
  minimum_stock: z.coerce.number().nonnegative().default(0),
  is_active: active,
})

export const warehouseSchema = z.object({
  code: code.max(30),
  name: name.max(150),
  address: z.string().trim().max(5000).nullable().optional(),
  is_active: active,
})

export const unitSchema = z.object({
  code: code.max(30),
  name: name.max(100),
  symbol: z.string().trim().min(1).max(20),
  is_active: active,
})

export const taxCodeSchema = z.object({
  code: code.max(30),
  name: name.max(100),
  tax_type: z.enum(['vat', 'withholding', 'other']),
  rate: z.coerce.number().min(0).max(100),
  input_tax_account_id: nullableId,
  output_tax_account_id: nullableId,
  is_active: active,
})

export const costCenterSchema = z.object({
  code: code.max(30),
  name: name.max(150),
  description: z.string().trim().max(5000).nullable().optional(),
  is_active: active,
})

export const projectSchema = z
  .object({
    code: code.max(30),
    name,
    customer_id: nullableId,
    start_date: date.nullable().optional(),
    end_date: date.nullable().optional(),
    status: z.enum(['active', 'on_hold', 'completed', 'cancelled', 'inactive']).default('active'),
    budget: z.coerce.number().nonnegative().default(0),
    description: z.string().trim().max(5000).nullable().optional(),
  })
  .refine((value) => !value.start_date || !value.end_date || value.start_date <= value.end_date, {
    message: 'Tanggal selesai proyek tidak boleh sebelum tanggal mulai',
    path: ['end_date'],
  })

export const bankAccountSchema = z.object({
  code: code.max(30),
  bank_name: name.max(150),
  account_number: z.string().trim().min(2).max(100),
  account_name: name.max(150),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
  gl_account_id: z.coerce.number().int().positive(),
  opening_balance: z.coerce.number().default(0),
  is_active: active,
})

export const entitySchemas = {
  accounting_periods: accountingPeriodSchema,
  accounts: accountSchema,
  customers: customerSchema,
  suppliers: supplierSchema,
  items: itemSchema,
  warehouses: warehouseSchema,
  units: unitSchema,
  tax_codes: taxCodeSchema,
  cost_centers: costCenterSchema,
  projects: projectSchema,
  bank_accounts: bankAccountSchema,
} as const
