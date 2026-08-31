import { z } from 'zod'

import { compareDecimal } from '../utils/decimal'
import {
  currencySchema,
  decimalSchema,
  isoDateSchema,
  moneySchema,
  nonnegativeQuantitySchema,
  quantitySchema,
} from './common.validator'
import { IMPORT_TYPES, type ImportType } from '../services/import/ImportDefinitions'

const blankToUndefined = (value: unknown) =>
  value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
    ? undefined
    : value
const blankToNull = (value: unknown) =>
  value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
    ? null
    : value

const requiredText = (max = 191) => z.string().trim().min(1).max(max)
const optionalText = (max = 191) =>
  z.preprocess(blankToNull, z.string().trim().max(max).nullable())
const optionalEmail = z.preprocess(blankToNull, z.email().max(191).nullable())
const optionalCode = optionalText(100)
const optionalMoney = z.preprocess(blankToUndefined, moneySchema.default('0.00'))
const optionalSignedMoney = z.preprocess(
  blankToUndefined,
  decimalSchema(2).default('0.00'),
)
const optionalQuantity = z.preprocess(
  blankToUndefined,
  nonnegativeQuantitySchema.default('0.0000'),
)
const optionalInteger = (defaultValue = 0) =>
  z.preprocess(
    blankToUndefined,
    z.coerce.number().int().nonnegative().max(1_000_000).default(defaultValue),
  )
const optionalCurrency = z.preprocess(blankToUndefined, currencySchema.default('IDR'))
const optionalBoolean = (defaultValue: boolean) =>
  z.preprocess((value) => {
    const normalized = blankToUndefined(value)
    if (normalized === undefined) return defaultValue
    if (typeof normalized === 'boolean') return normalized
    const text = String(normalized).trim().toLowerCase()
    if (['1', 'true', 'yes', 'ya', 'y'].includes(text)) return true
    if (['0', 'false', 'no', 'tidak', 'n'].includes(text)) return false
    return normalized
  }, z.boolean())

const customer = z.object({
  customer_code: requiredText(30),
  customer_name: requiredText(),
  email: optionalEmail,
  phone: optionalText(50),
  address: optionalText(5000),
  city: optionalText(100),
  tax_number: optionalText(50),
  payment_term: optionalInteger(),
  currency: optionalCurrency,
  credit_limit: optionalMoney,
  receivable_account_code: optionalCode,
  opening_balance: optionalSignedMoney,
  opening_balance_date: z.preprocess(blankToNull, isoDateSchema.nullable()),
  opening_balance_offset_account_code: optionalCode,
})

const supplier = z.object({
  supplier_code: requiredText(30),
  supplier_name: requiredText(),
  email: optionalEmail,
  phone: optionalText(50),
  address: optionalText(5000),
  city: optionalText(100),
  tax_number: optionalText(50),
  payment_term: optionalInteger(),
  currency: optionalCurrency,
  payable_account_code: optionalCode,
  opening_balance: optionalSignedMoney,
  opening_balance_date: z.preprocess(blankToNull, isoDateSchema.nullable()),
  opening_balance_offset_account_code: optionalCode,
})

const item = z.object({
  item_code: requiredText(50),
  item_name: requiredText(),
  item_type: z.preprocess(
    (value) => String(value).trim().toLowerCase(),
    z.enum(['inventory', 'service', 'non_inventory']),
  ),
  unit: requiredText(30),
  warehouse: optionalCode,
  purchase_price: optionalMoney,
  selling_price: optionalMoney,
  opening_stock: optionalQuantity,
  opening_stock_date: z.preprocess(blankToNull, isoDateSchema.nullable()),
  minimum_stock: optionalQuantity,
  description: optionalText(5000),
  barcode: optionalText(100),
  sales_account_code: optionalCode,
  inventory_account_code: optionalCode,
  cogs_account_code: optionalCode,
  purchase_account_code: optionalCode,
})

const chartOfAccounts = z.object({
  account_code: requiredText(30),
  account_name: requiredText(),
  account_type: z.preprocess(
    (value) => String(value).trim().toLowerCase(),
    z.enum([
      'asset',
      'liability',
      'equity',
      'revenue',
      'cogs',
      'expense',
      'other_income',
      'other_expense',
    ]),
  ),
  normal_balance: z.preprocess(
    (value) => String(value).trim().toLowerCase(),
    z.enum(['debit', 'credit']),
  ),
  parent_code: optionalCode,
  is_header: optionalBoolean(false),
  is_posting: optionalBoolean(true),
  allow_manual_journal: optionalBoolean(true),
  cash_flow_category: z.preprocess(
    blankToNull,
    z.enum(['operating', 'investing', 'financing', 'non_cash']).nullable(),
  ),
  report_group: optionalText(100),
})

const openingBalance = z
  .object({
    as_of_date: isoDateSchema,
    reference: optionalText(100),
    description: optionalText(500),
    account_code: requiredText(30),
    debit: moneySchema,
    credit: moneySchema,
  })
  .superRefine((value, context) => {
    const debit = compareDecimal(value.debit, '0') > 0
    const credit = compareDecimal(value.credit, '0') > 0
    if (debit === credit) {
      context.addIssue({
        code: 'custom',
        path: ['debit'],
        message: 'Isi salah satu nilai debit atau kredit',
      })
    }
  })

const invoiceLineBase = {
  transaction_date: isoDateSchema,
  invoice_number: requiredText(100),
  item_code: requiredText(50),
  quantity: quantitySchema,
  unit_price: moneySchema,
  discount: optionalMoney,
  tax_code: optionalCode,
  warehouse: optionalCode,
  due_date: isoDateSchema,
  description: requiredText(500),
}

const sales = z
  .object({ ...invoiceLineBase, customer_code: requiredText(30) })
  .refine((value) => value.due_date >= value.transaction_date, {
    path: ['due_date'],
    message: 'Jatuh tempo tidak boleh sebelum tanggal transaksi',
  })

const purchase = z
  .object({ ...invoiceLineBase, supplier_code: requiredText(30) })
  .refine((value) => value.due_date >= value.transaction_date, {
    path: ['due_date'],
    message: 'Jatuh tempo tidak boleh sebelum tanggal transaksi',
  })

const journal = z
  .object({
    journal_date: isoDateSchema,
    reference: requiredText(100),
    description: requiredText(500),
    account_code: requiredText(30),
    debit: moneySchema,
    credit: moneySchema,
    cost_center: optionalCode,
    project: optionalCode,
  })
  .superRefine((value, context) => {
    const debit = compareDecimal(value.debit, '0') > 0
    const credit = compareDecimal(value.credit, '0') > 0
    if (debit === credit) {
      context.addIssue({
        code: 'custom',
        path: ['debit'],
        message: 'Isi salah satu nilai debit atau kredit',
      })
    }
  })

const inventory = z.object({
  as_of_date: isoDateSchema,
  reference: optionalText(100),
  item_code: requiredText(50),
  warehouse: requiredText(30),
  quantity: quantitySchema,
  unit_cost: z.preprocess(blankToUndefined, decimalSchema(6, { nonnegative: true })),
  description: optionalText(500),
})

const bankStatement = z
  .object({
    bank_account_code: requiredText(30),
    statement_number: requiredText(100),
    transaction_date: isoDateSchema,
    description: requiredText(500),
    reference: optionalText(191),
    debit: moneySchema,
    credit: moneySchema,
    balance: decimalSchema(2),
  })
  .superRefine((value, context) => {
    const debit = compareDecimal(value.debit, '0') > 0
    const credit = compareDecimal(value.credit, '0') > 0
    if (debit === credit) {
      context.addIssue({
        code: 'custom',
        path: ['debit'],
        message: 'Isi salah satu nilai debit atau kredit',
      })
    }
  })

export const importRowSchemas = {
  customer,
  supplier,
  item,
  chart_of_accounts: chartOfAccounts,
  opening_balance: openingBalance,
  sales,
  purchase,
  journal,
  inventory,
  bank_statement: bankStatement,
} satisfies Record<ImportType, z.ZodType>

export const importTypeSchema = z.enum(IMPORT_TYPES)
export const templateFormatSchema = z.enum(['csv', 'xlsx']).default('xlsx')
export const importIdSchema = z.coerce.number().int().positive()
export const importConfirmSchema = z.object({
  error_policy: z.enum(['all_or_nothing', 'valid_only']),
  import_as: z.enum(['draft', 'submitted']).default('draft'),
  skip_duplicates: z.literal(true).default(true),
})
export const importRowsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.enum(['valid', 'warning', 'error', 'duplicate']).optional(),
})
export const importHistoryQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  type: importTypeSchema.optional(),
  status: z
    .enum([
      'uploaded',
      'validating',
      'validation_failed',
      'ready',
      'importing',
      'processing',
      'completed',
      'completed_with_errors',
      'failed',
      'cancelled',
    ])
    .optional(),
})

export type ImportConfirmInput = z.infer<typeof importConfirmSchema>
