import { z } from 'zod'
import { compareDecimal } from '../utils/decimal'
import {
  positiveIdSchema as id,
  positiveMoneySchema as money,
  moneySchema,
  isoDateSchema as date,
  quantitySchema,
  nonnegativeQuantitySchema,
} from './common.validator'
const common = { request_key: z.uuid(), date, reference: z.string().trim().max(100).default('') }
export const settlementSchema = z
  .object({
    ...common,
    invoice_id: id.optional(),
    cash_account_id: id,
    bank_account_id: id.optional(),
    exchange_rate: z.coerce.number().finite().positive().max(1e10).optional(),
    payment_method: z
      .enum(['cash', 'bank_transfer', 'check', 'card', 'qris', 'payment_gateway', 'other'])
      .default('bank_transfer'),
    processing_fee_amount: money.default('0.00'),
    processing_fee_rate: z.coerce.number().finite().min(0).max(100).default(0),
    processing_fee_account_id: id.optional(),
    amount: money.optional(),
    allocations: z
      .array(z.object({ invoice_id: id, amount: money }))
      .min(1)
      .max(100)
      .optional(),
  })
  .superRefine((value, context) => {
    if (!value.allocations?.length && (!value.invoice_id || !value.amount))
      context.addIssue({
        code: 'custom',
        message: 'Pilih minimal satu invoice dan jumlah pelunasannya',
        path: ['allocations'],
      })
    if (
      value.allocations &&
      new Set(value.allocations.map((item) => item.invoice_id)).size !== value.allocations.length
    )
      context.addIssue({
        code: 'custom',
        message: 'Invoice tidak boleh dipilih lebih dari sekali',
        path: ['allocations'],
      })
  })
export const settlementListSchema = z
  .object({
    invoice_id: id.optional(),
    date_from: date.optional(),
    date_to: date.optional(),
    status: z.enum(['posted', 'reversed', 'cancelled']).optional(),
    search: z.string().trim().max(100).optional(),
  })
  .refine((value) => !value.date_from || !value.date_to || value.date_from <= value.date_to, {
    message: 'Rentang tanggal tidak valid',
  })
export const stockOperationSchema = z
  .object({
    ...common,
    warehouse_id: id,
    to_warehouse_id: id.optional(),
    item_id: id.optional(),
    quantity: quantitySchema.optional(),
    actual_quantity: nonnegativeQuantitySchema.optional(),
    gain_loss_account_id: id.optional(),
    unit_cost: money.optional(),
    unit_id: id.optional(),
    reason: z.string().trim().min(3).max(255),
    lines: z
      .array(
        z.object({
          item_id: id,
          unit_id: id.optional(),
          quantity: quantitySchema.optional(),
          actual_quantity: nonnegativeQuantitySchema.optional(),
          gain_loss_account_id: id.optional(),
          unit_cost: money.optional(),
        }),
      )
      .min(1)
      .max(500)
      .optional(),
  })
  .superRefine((value, ctx) => {
    const lines = value.lines ?? (value.item_id ? [{ item_id: value.item_id }] : [])
    if (!lines.length)
      ctx.addIssue({ code: 'custom', message: 'Tambahkan minimal satu barang', path: ['lines'] })
    if (new Set(lines.map((line) => line.item_id)).size !== lines.length)
      ctx.addIssue({ code: 'custom', message: 'Barang tidak boleh duplikat', path: ['lines'] })
  })
export const operationListSchema = z
  .object({
    date_from: date,
    date_to: date,
    account_id: id.optional(),
    item_id: id.optional(),
    warehouse_id: id.optional(),
    search: z.string().trim().max(100).optional(),
  })
  .refine((v) => v.date_from <= v.date_to, 'Rentang tanggal tidak valid')
type ParsedSettlementInput = z.output<typeof settlementSchema>
export type SettlementInput = Omit<
  ParsedSettlementInput,
  'payment_method' | 'processing_fee_amount' | 'processing_fee_rate'
> &
  Partial<
    Pick<ParsedSettlementInput, 'payment_method' | 'processing_fee_amount' | 'processing_fee_rate'>
  >
export const reversalOperationSchema = z.object({
  request_key: z.uuid(),
  date,
  reason: z.string().trim().min(3).max(500),
})
export type ReversalInput = z.output<typeof reversalOperationSchema>
export const creditActionSchema = z.object({
  ...common,
  credit_id: id,
  invoice_id: id.optional(),
  cash_account_id: id.optional(),
  bank_account_id: id.optional(),
  amount: money,
})
export type CreditActionInput = z.output<typeof creditActionSchema>
export type StockOperationInput = z.output<typeof stockOperationSchema>
export const purchaseReturnSchema = z
  .object({
    ...common,
    invoice_id: id,
    return_stock: z.boolean().default(true),
    adjustment_account_id: id.optional(),
    reason: z.string().trim().min(3).max(255),
    lines: z
      .array(z.object({ invoice_line_id: id, quantity: quantitySchema }))
      .min(1)
      .max(500),
  })
  .refine(
    (v) => new Set(v.lines.map((l) => l.invoice_line_id)).size === v.lines.length,
    'Baris invoice tidak boleh duplikat',
  )
export type PurchaseReturnInput = z.output<typeof purchaseReturnSchema>
export const assetSchema = z
  .object({
    ...common,
    code: z.string().trim().min(1).max(50),
    name: z.string().trim().min(2).max(191),
    in_service_date: date,
    cost: money,
    salvage_value: moneySchema.default('0.00'),
    life_months: z.coerce.number().int().min(1).max(1200).optional(),
    asset_account_id: id,
    accumulated_account_id: id,
    expense_account_id: id,
    counterpart_account_id: id.optional(),
    already_recorded: z.boolean().default(false),
    location: z.string().trim().max(191).default(''),
    serial_number: z.string().trim().max(100).default(''),
  })
  .refine((v) => v.in_service_date >= v.date, 'Tanggal mulai pakai harus setelah perolehan')
  .refine((v) => Number(v.salvage_value) <= Number(v.cost), 'Nilai residu melebihi harga perolehan')
export const depreciationSchema = z.object({ request_key: z.uuid(), asset_id: id, date })
export type AssetInput = z.output<typeof assetSchema>
export const printTemplateSchema = z.object({
  templateId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(),
  templateName: z.string().trim().min(1).max(100).default('Standar'),
  setDefault: z.boolean().default(true),
  templateVersion: z.coerce.number().int().nonnegative().optional(),
  documentType: z.enum([
    'sales_invoice',
    'purchase_invoice',
    'sales_order',
    'purchase_order',
    'payroll_slip',
    'customer_payment_receipt',
    'supplier_payment_voucher',
    'general_journal',
    'general_ledger',
    'trial_balance',
    'profit_loss',
    'balance_sheet',
    'equity_changes',
    'cash_flow',
    'stock_transfer',
    'stock_adjustment',
    'fixed_asset_register',
    'depreciation_schedule',
    'tax_reconciliation',
    'month_end_report',
  ]),
  templateStyle: z.enum(['modern', 'classic', 'compact']).default('modern'),
  fontSize: z.coerce.number().int().min(8).max(18),
  pageSize: z.enum(['A4', 'A5', 'Letter']),
  orientation: z.enum(['portrait', 'landscape']),
  marginMm: z.coerce.number().int().min(5).max(30).default(14),
  marginTopMm: z.coerce.number().min(5).max(40).nullable().default(null),
  marginRightMm: z.coerce.number().min(5).max(40).nullable().default(null),
  marginBottomMm: z.coerce.number().min(5).max(40).nullable().default(null),
  marginLeftMm: z.coerce.number().min(5).max(40).nullable().default(null),
  logoPlacement: z.enum(['inline', 'free']).default('inline'),
  logoXmm: z.coerce.number().min(0).max(420).default(0),
  logoYmm: z.coerce.number().min(0).max(594).default(0),
  logoWidthMm: z.coerce.number().min(5).max(150).default(20),
  logoHeightMm: z.coerce.number().min(5).max(150).default(20),
  columnWidths: z.partialRecord(z.enum(['code','name','quantity','unit','price','discount','tax','subtotal']), z.coerce.number().min(1).max(100)).default({}),
  showCompany: z.boolean(),
  showReference: z.boolean(),
  showNotes: z.boolean(),
  showTax: z.boolean(),
  showSignature: z.boolean(),
  showPaymentInfo: z.boolean().default(false),
  showPageNumber: z.boolean().default(true),
  headerTitle: z.string().trim().max(100).default(''),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#2563eb'),
  paymentInfo: z.string().max(500).default(''),
  paymentTerms: z.string().max(500).default(''),
  paymentQr: z.string().max(500_000).default(''),
  partnerLabel: z.string().trim().max(50).default(''),
  totalLabel: z.string().trim().max(50).default('Total Tagihan'),
  signatureLabels: z
    .array(z.string().trim().min(1).max(50))
    .length(3)
    .default(['Dibuat oleh', 'Disetujui oleh', 'Diterima oleh']),
  columns: z
    .array(z.enum(['code', 'name', 'quantity', 'unit', 'price', 'discount', 'tax', 'subtotal']))
    .min(1)
    .max(8)
    .refine(
      (columns) => new Set(columns).size === columns.length,
      'Kolom dokumen tidak boleh duplikat',
    )
    .refine((columns) => columns.includes('name'), 'Kolom nama barang/jasa wajib ditampilkan')
    .default(['code', 'name', 'quantity', 'unit', 'price', 'tax', 'subtotal']),
  watermark: z.enum(['', 'DRAFT', 'LUNAS', 'DIBATALKAN']).default(''),
  footer: z.string().max(500),
}).superRefine((t, ctx) => {
  if (t.logoPlacement !== 'free') return
  const paper = t.pageSize === 'A5' ? [148,210] : t.pageSize === 'Letter' ? [215.9,279.4] : [210,297]
  const [width,height] = t.orientation === 'landscape' ? [paper[1]!,paper[0]!] : [paper[0]!,paper[1]!]
  const usableWidth = width - (t.marginLeftMm ?? t.marginMm) - (t.marginRightMm ?? t.marginMm)
  const usableHeight = height - (t.marginTopMm ?? t.marginMm) - (t.marginBottomMm ?? t.marginMm)
  if (t.logoXmm + t.logoWidthMm > usableWidth) ctx.addIssue({code:'custom',path:['logoXmm'],message:'Logo melewati batas kanan area cetak'})
  if (t.logoYmm + t.logoHeightMm > usableHeight) ctx.addIssue({code:'custom',path:['logoYmm'],message:'Logo melewati batas bawah area cetak'})
})
export const bankingQuerySchema = z
  .object({
    date_from: date,
    date_to: date,
    bank_account_id: id.optional(),
    account_id: id.optional(),
  })
  .refine((v) => v.date_from <= v.date_to, 'Rentang tanggal tidak valid')
export const statementSchema = z.object({
  request_key: z.uuid(),
  bank_account_id: id,
  number: z.string().trim().min(1).max(100),
  date_from: date,
  date_to: date,
  opening_balance: z.coerce.number().finite(),
  closing_balance: z.coerce.number().finite(),
  lines: z
    .array(
      z.object({
        date,
        description: z.string().trim().min(1).max(500),
        reference: z.string().max(191).default(''),
        debit: moneySchema,
        credit: moneySchema,
        balance: z.coerce.number().finite(),
      }),
    )
    .min(1)
    .max(1000),
})
export const bankMatchSchema = z.object({
  request_key: z.uuid(),
  statement_line_id: id,
  journal_line_id: id,
})
export const bankMatchBatchSchema = z.object({
  request_key: z.uuid(),
  allocations: z
    .array(
      z.object({
        statement_line_id: id,
        journal_line_id: id,
        matched_amount: z.coerce.number().positive().max(999_999_999_999),
      }),
    )
    .min(1)
    .max(500),
})
export const bankUnmatchSchema = z.object({ request_key: z.uuid(), statement_line_id: id })
export const bankMatchingRuleSchema = z
  .object({
    id: id.optional(),
    name: z.string().trim().min(2).max(191),
    bank_account_id: id.nullable().optional(),
    priority: z.coerce.number().int().min(1).max(9999).default(100),
    direction: z.enum(['any', 'inflow', 'outflow']).default('any'),
    description_pattern: z.string().trim().max(255).nullable().optional(),
    reference_pattern: z.string().trim().max(255).nullable().optional(),
    amount_min: moneySchema.nullable().optional(),
    amount_max: moneySchema.nullable().optional(),
    date_tolerance_days: z.coerce.number().int().min(0).max(31).default(3),
    is_active: z.boolean().default(true),
  })
  .refine(
    (value) =>
      value.amount_min == null ||
      value.amount_max == null ||
      Number(value.amount_min) <= Number(value.amount_max),
    { path: ['amount_max'], message: 'Batas nilai maksimum harus sama atau lebih besar' },
  )
export const bankImportMappingSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(2).max(191),
  bank_account_id: id.nullable().optional(),
  delimiter: z.enum([',', ';', '\\t']).default(','),
  date_format: z.enum(['DD/MM/YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY']).default('DD/MM/YYYY'),
  decimal_separator: z.enum(['dot', 'comma']).default('dot'),
  header_row: z.coerce.number().int().min(1).max(100).default(1),
  column_mapping: z.object({
    transaction_date: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(100),
    reference: z.string().trim().max(100).default(''),
    debit: z.string().trim().max(100).default(''),
    credit: z.string().trim().max(100).default(''),
    amount: z.string().trim().max(100).default(''),
    balance: z.string().trim().max(100).default(''),
  }),
  is_default: z.boolean().default(false),
  is_active: z.boolean().default(true),
}).superRefine((value, context) => {
  if (!value.column_mapping.balance)
    context.addIssue({ code: 'custom', path: ['column_mapping', 'balance'], message: 'Kolom saldo wajib dipetakan' })
  if (!value.column_mapping.amount && (!value.column_mapping.debit || !value.column_mapping.credit))
    context.addIssue({ code: 'custom', path: ['column_mapping', 'amount'], message: 'Petakan kolom nominal, atau kolom debit dan kredit' })
})
export const itemUnitsSchema = z.object({
  units: z
    .array(
      z.object({
        unit_id: id,
        factor_to_stock: z.coerce.number().positive().max(1_000_000),
        is_purchase: z.boolean().default(true),
        is_sales: z.boolean().default(true),
        barcode: z.string().trim().max(100).nullable().optional(),
        is_active: z.boolean().default(true),
      }),
    )
    .min(1)
    .max(50),
})
export const savedViewSchema = z.object({
  screen_key: z.string().trim().min(2).max(100),
  name: z.string().trim().min(2).max(100),
  filters: z.record(z.string(), z.unknown()),
  is_default: z.boolean().default(false),
})
export const backupSchema = z.object({ type: z.enum(['full', 'schema', 'data']).default('full') })
export const restoreSchema = z.object({ backup_id: id, confirmation: z.string().min(1).max(100) })
export const budgetSchema = z
  .object({
    request_key: z.uuid(),
    name: z.string().trim().min(3).max(191),
    year: z.coerce.number().int().min(1900).max(2200),
    notes: z.string().trim().max(2000).default(''),
    lines: z
      .array(
        z.object({
          account_id: id,
          cost_center_id: id.nullable().optional(),
          project_id: id.nullable().optional(),
          amounts: z.array(moneySchema).length(12),
        }),
      )
      .min(1)
      .max(200),
  })
  .refine(
    (v) =>
      new Set(v.lines.map((l) => `${l.account_id}:${l.cost_center_id ?? 0}:${l.project_id ?? 0}`))
        .size === v.lines.length,
    'Akun dan dimensi tidak boleh berulang',
  )
export const budgetApprovalSchema = z.object({ request_key: z.uuid(), id })
