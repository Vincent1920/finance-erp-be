import { z } from 'zod'
export const customerSchema = z.object({
  code: z.string().min(2).max(30),
  name: z.string().min(2).max(191),
  tax_number: z.string().max(50).nullable().optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  address: z.string().nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  credit_limit: z.coerce.number().nonnegative().default(0),
  payment_term_days: z.coerce.number().int().nonnegative().default(0),
  receivable_account_id: z.coerce.number().int().positive().nullable().optional(),
  is_active: z.boolean().default(true),
})
export const supplierSchema = customerSchema
  .omit({ credit_limit: true, receivable_account_id: true })
  .extend({ payable_account_id: z.coerce.number().int().positive().nullable().optional() })
export const accountSchema = z.object({
  code: z.string().min(2).max(30),
  name: z.string().min(2).max(191),
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
  parent_id: z.coerce.number().int().positive().nullable().optional(),
  level: z.coerce.number().int().min(0).max(10).default(0),
  is_header: z.boolean().default(false),
  is_posting: z.boolean().default(true),
  is_active: z.boolean().default(true),
  allow_manual_journal: z.boolean().default(true),
})
export const itemSchema = z.object({
  sku: z.string().min(1).max(50),
  barcode: z.string().max(100).nullable().optional(),
  name: z.string().min(2).max(191),
  description: z.string().nullable().optional(),
  item_type: z.enum(['inventory', 'service', 'non_inventory']),
  unit_id: z.coerce.number().int().positive(),
  sales_account_id: z.coerce.number().int().positive().nullable().optional(),
  inventory_account_id: z.coerce.number().int().positive().nullable().optional(),
  cogs_account_id: z.coerce.number().int().positive().nullable().optional(),
  purchase_account_id: z.coerce.number().int().positive().nullable().optional(),
  sales_price: z.coerce.number().nonnegative(),
  purchase_price: z.coerce.number().nonnegative(),
  average_cost: z.coerce.number().nonnegative().default(0),
  minimum_stock: z.coerce.number().nonnegative().default(0),
  is_active: z.boolean().default(true),
})
