import { z } from 'zod'

import {
  InvoiceRepository,
  type InvoiceKind,
  type InvoiceLineWrite,
  type InvoiceTotalsWrite,
} from '../repositories/InvoiceRepository'
import type { QueryExecutor } from '../types/database'
import { ConflictError, NotFoundError, ValidationError } from '../utils/AppError'
import {
  addDecimal,
  compareDecimal,
  multiplyDecimal,
  normalizeDecimal,
  percentageOf,
  subtractDecimal,
  type DecimalInput,
} from '../utils/decimal'
import {
  currencySchema,
  exchangeRateSchema,
  isoDateSchema,
  moneySchema,
  optionalIdSchema,
  percentageSchema,
  positiveIdSchema,
  quantitySchema,
} from '../validators/common.validator'
import { BusinessValidationService } from './BusinessValidationService'

const invoiceLineBaseSchema = z.object({
  itemId: positiveIdSchema,
  description: z.string().trim().max(255).nullable().optional(),
  quantity: quantitySchema,
  unitId: optionalIdSchema,
  unitPrice: moneySchema,
  discount: moneySchema.default('0.00'),
  discountPercent: percentageSchema.optional(),
  taxCodeId: optionalIdSchema,
})

const invoiceBaseShape = {
  invoiceNumber: z.string().trim().min(1).max(50),
  invoiceDate: isoDateSchema,
  dueDate: isoDateSchema,
  warehouseId: optionalIdSchema,
  reference: z.string().trim().max(100).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  currency: currencySchema.default('IDR'),
  exchangeRate: exchangeRateSchema.default('1.00000000'),
  importAs: z.enum(['draft', 'submitted']).default('draft'),
} as const

function validateInvoiceDatesAndLines(
  value: { invoiceDate: string; dueDate: string; lines: unknown[] },
  context: z.RefinementCtx,
) {
  if (value.dueDate < value.invoiceDate) {
    context.addIssue({
      code: 'custom',
      message: 'Tanggal jatuh tempo tidak boleh sebelum tanggal invoice',
      path: ['dueDate'],
    })
  }
}

export const importedSalesInvoiceSchema = z
  .object({
    ...invoiceBaseShape,
    customerId: positiveIdSchema,
    lines: z
      .array(invoiceLineBaseSchema.extend({ revenueAccountId: optionalIdSchema }))
      .min(1)
      .max(500),
  })
  .superRefine(validateInvoiceDatesAndLines)

export const importedPurchaseInvoiceSchema = z
  .object({
    ...invoiceBaseShape,
    supplierId: positiveIdSchema,
    supplierInvoiceNumber: z.string().trim().min(1).max(100).nullable().optional(),
    lines: z
      .array(invoiceLineBaseSchema.extend({ expenseAccountId: optionalIdSchema }))
      .min(1)
      .max(500),
  })
  .superRefine(validateInvoiceDatesAndLines)

export type ImportedSalesInvoiceInput = z.input<typeof importedSalesInvoiceSchema>
export type ImportedPurchaseInvoiceInput = z.input<typeof importedPurchaseInvoiceSchema>
export type ParsedSalesInvoiceInput = z.output<typeof importedSalesInvoiceSchema>
export type ParsedPurchaseInvoiceInput = z.output<typeof importedPurchaseInvoiceSchema>

export interface InvoiceMutationContext {
  userId: number
  requestId?: string | null
  ip?: string | null
}

export interface CreatedImportedInvoice {
  id: number
  invoiceNumber: string
  status: 'draft' | 'pending_approval'
  totals: InvoiceTotalsWrite
}

export interface CalculatedInvoiceLine {
  quantity: string
  unitPrice: string
  grossAmount: string
  discount: string
  discountPercent: string
  subtotal: string
  taxRate: string
  taxAmount: string
  grandTotal: string
  baseSubtotal: string
  baseTaxAmount: string
}

interface LineCalculationInput {
  quantity: DecimalInput
  unitPrice: DecimalInput
  discount?: DecimalInput
  discountPercent?: DecimalInput
  taxRate?: DecimalInput
  exchangeRate?: DecimalInput
}

export function calculateInvoiceLine(input: LineCalculationInput): CalculatedInvoiceLine {
  const quantity = normalizeDecimal(input.quantity, 4)
  const unitPrice = normalizeDecimal(input.unitPrice)
  const explicitDiscount = normalizeDecimal(input.discount ?? '0')
  const discountPercent = normalizeDecimal(input.discountPercent ?? '0', 4)
  const taxRate = normalizeDecimal(input.taxRate ?? '0', 4)
  const exchangeRate = normalizeDecimal(input.exchangeRate ?? '1', 8)

  if (compareDecimal(quantity, '0', 4) <= 0) {
    throw new ValidationError('Kuantitas invoice harus lebih dari nol')
  }
  if (compareDecimal(unitPrice, '0') < 0) {
    throw new ValidationError('Harga invoice tidak boleh negatif')
  }
  if (compareDecimal(explicitDiscount, '0') < 0) {
    throw new ValidationError('Diskon invoice tidak boleh negatif')
  }
  if (compareDecimal(explicitDiscount, '0') > 0 && compareDecimal(discountPercent, '0', 4) > 0) {
    throw new ValidationError('Gunakan nilai diskon atau persentase diskon, bukan keduanya')
  }
  if (
    compareDecimal(discountPercent, '0', 4) < 0 ||
    compareDecimal(discountPercent, '100', 4) > 0
  ) {
    throw new ValidationError('Persentase diskon harus antara 0 dan 100')
  }
  if (compareDecimal(taxRate, '0', 4) < 0 || compareDecimal(taxRate, '100', 4) > 0) {
    throw new ValidationError('Tarif pajak harus antara 0 dan 100')
  }
  if (compareDecimal(exchangeRate, '0', 8) <= 0) {
    throw new ValidationError('Kurs harus lebih dari nol')
  }

  const grossAmount = multiplyDecimal(quantity, 4, unitPrice, 2)
  const discount =
    compareDecimal(discountPercent, '0', 4) > 0
      ? percentageOf(grossAmount, discountPercent)
      : explicitDiscount
  if (compareDecimal(discount, grossAmount) > 0) {
    throw new ValidationError('Diskon tidak boleh melebihi nilai bruto baris invoice')
  }

  const subtotal = subtractDecimal(grossAmount, discount)
  const taxAmount = percentageOf(subtotal, taxRate)
  const grandTotal = addDecimal([subtotal, taxAmount])

  return {
    quantity,
    unitPrice,
    grossAmount,
    discount,
    discountPercent: normalizeDecimal(discountPercent, 6),
    subtotal,
    taxRate,
    taxAmount,
    grandTotal,
    baseSubtotal: multiplyDecimal(subtotal, 2, exchangeRate, 8),
    baseTaxAmount: multiplyDecimal(taxAmount, 2, exchangeRate, 8),
  }
}

export function calculateInvoiceTotals(
  lines: readonly CalculatedInvoiceLine[],
  exchangeRate: DecimalInput,
): InvoiceTotalsWrite {
  const subtotal = addDecimal(lines.map((line) => line.grossAmount))
  const discount = addDecimal(lines.map((line) => line.discount))
  const tax = addDecimal(lines.map((line) => line.taxAmount))
  const grandTotal = addDecimal(lines.map((line) => line.grandTotal))
  const rate = normalizeDecimal(exchangeRate, 8)
  return {
    subtotal,
    discount,
    tax,
    grandTotal,
    baseSubtotal: multiplyDecimal(subtotal, 2, rate, 8),
    baseDiscount: multiplyDecimal(discount, 2, rate, 8),
    baseTax: multiplyDecimal(tax, 2, rate, 8),
    baseGrandTotal: multiplyDecimal(grandTotal, 2, rate, 8),
  }
}

interface DomainLineInput {
  itemId: number
  description?: string | null
  quantity: string
  unitId?: number | null
  unitPrice: string
  discount: string
  discountPercent?: string
  taxCodeId?: number | null
  accountId?: number | null
}

interface PrepareInvoiceInput {
  invoiceNumber: string
  invoiceDate: string
  dueDate: string
  partyId: number
  warehouseId?: number | null
  currency: string
  exchangeRate: string
  lines: DomainLineInput[]
}

export interface PreparedImportedInvoice {
  accountingPeriodId: number
  warehouseId?: number | null
  totals: InvoiceTotalsWrite
  lines: InvoiceLineWrite[]
}

export async function prepareImportedInvoice(
  connection: QueryExecutor,
  companyId: number,
  kind: InvoiceKind,
  input: PrepareInvoiceInput,
  repository: InvoiceRepository,
  validation: BusinessValidationService,
): Promise<PreparedImportedInvoice> {
  if (!Number.isSafeInteger(companyId) || companyId <= 0) {
    throw new ValidationError('Company invoice tidak valid')
  }

  const period = await validation.ensureOpenPeriod(connection, companyId, input.invoiceDate)
  const party = await repository.findParty(connection, kind, companyId, input.partyId)
  if (!party) {
    throw new NotFoundError(
      kind === 'sales'
        ? 'Pelanggan tidak ditemukan atau tidak aktif'
        : 'Pemasok tidak ditemukan atau tidak aktif',
    )
  }
  if (String(party.currency).toUpperCase() !== input.currency) {
    throw new ValidationError(
      `Mata uang invoice harus sama dengan mata uang ${kind === 'sales' ? 'pelanggan' : 'pemasok'}`,
    )
  }

  const warehouseId = input.warehouseId ?? null
  if (warehouseId) {
    const warehouse = await repository.findWarehouse(connection, companyId, warehouseId)
    if (!warehouse) throw new NotFoundError('Gudang tidak ditemukan atau tidak aktif')
  }

  const itemRows = await repository.findItems(
    connection,
    companyId,
    input.lines.map((line) => line.itemId),
  )
  const items = new Map(itemRows.map((item) => [Number(item.id), item]))
  const selectedUnitIds: number[] = []
  const taxCodeIds: number[] = []

  for (const [index, line] of input.lines.entries()) {
    const item = items.get(line.itemId)
    if (!item) {
      throw new NotFoundError(
        `Barang/jasa pada baris ${index + 1} tidak ditemukan atau tidak aktif`,
      )
    }
    const unitId = line.unitId ?? Number(item.unit_id)
    if (unitId !== Number(item.unit_id)) {
      throw new ValidationError(
        `Satuan pada baris ${index + 1} harus sama dengan satuan utama barang karena konversi satuan belum dikonfigurasi`,
      )
    }
    selectedUnitIds.push(unitId)
    if (line.taxCodeId) taxCodeIds.push(line.taxCodeId)
    if (item.item_type === 'inventory' && !warehouseId) {
      throw new ValidationError(`Gudang wajib diisi untuk barang inventory pada baris ${index + 1}`)
    }
  }

  const [unitRows, taxRows] = await Promise.all([
    repository.findUnits(connection, companyId, selectedUnitIds),
    repository.findTaxCodes(connection, companyId, taxCodeIds),
  ])
  const units = new Set(unitRows.map((unit) => Number(unit.id)))
  const taxes = new Map(taxRows.map((tax) => [Number(tax.id), tax]))
  const accountIds: number[] = []

  if (!party.control_account_id) {
    throw new ValidationError(
      `${kind === 'sales' ? 'Akun piutang pelanggan' : 'Akun utang pemasok'} belum dikonfigurasi`,
    )
  }
  accountIds.push(Number(party.control_account_id))

  for (const [index, line] of input.lines.entries()) {
    const item = items.get(line.itemId)!
    const unitId = line.unitId ?? Number(item.unit_id)
    if (!units.has(unitId)) {
      throw new NotFoundError(`Satuan pada baris ${index + 1} tidak ditemukan atau tidak aktif`)
    }
    const fallbackAccount =
      kind === 'sales'
        ? item.sales_account_id
        : (item.purchase_account_id ?? item.inventory_account_id)
    const accountId = line.accountId ?? (fallbackAccount ? Number(fallbackAccount) : null)
    if (!accountId) {
      throw new ValidationError(
        `${kind === 'sales' ? 'Akun pendapatan' : 'Akun pembelian/beban'} pada baris ${index + 1} belum dikonfigurasi`,
      )
    }
    accountIds.push(accountId)

    if (line.taxCodeId) {
      const tax = taxes.get(line.taxCodeId)
      if (!tax) {
        throw new NotFoundError(
          `Kode pajak pada baris ${index + 1} tidak ditemukan atau tidak aktif`,
        )
      }
      if (compareDecimal(tax.rate, '0', 4) > 0) {
        const taxAccount = kind === 'sales' ? tax.output_tax_account_id : tax.input_tax_account_id
        if (!taxAccount) {
          throw new ValidationError(`Akun pajak pada baris ${index + 1} belum dikonfigurasi`)
        }
        accountIds.push(Number(taxAccount))
      }
    }
  }

  const accountRows = await repository.findAccounts(connection, companyId, accountIds)
  const accounts = new Set(accountRows.map((account) => Number(account.id)))
  for (const accountId of new Set(accountIds)) {
    if (!accounts.has(accountId)) {
      throw new NotFoundError(
        `Akun ${accountId} tidak ditemukan, tidak aktif, atau bukan akun posting`,
      )
    }
  }

  const calculatedLines = input.lines.map((line) => {
    const taxRate = line.taxCodeId ? taxes.get(line.taxCodeId)!.rate : '0'
    return calculateInvoiceLine({
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discount: line.discount,
      discountPercent: line.discountPercent,
      taxRate,
      exchangeRate: input.exchangeRate,
    })
  })
  const totals = calculateInvoiceTotals(calculatedLines, input.exchangeRate)
  if (compareDecimal(totals.grandTotal, '0') <= 0) {
    throw new ValidationError('Nilai total invoice harus lebih dari nol')
  }

  const lines = input.lines.map<InvoiceLineWrite>((line, index) => {
    const item = items.get(line.itemId)!
    const accountId =
      line.accountId ??
      Number(
        kind === 'sales'
          ? item.sales_account_id
          : (item.purchase_account_id ?? item.inventory_account_id),
      )
    const calculated = calculatedLines[index]!
    return {
      lineNumber: index + 1,
      itemId: line.itemId,
      description: line.description,
      quantity: calculated.quantity,
      unitId: line.unitId ?? Number(item.unit_id),
      unitPrice: calculated.unitPrice,
      discount: calculated.discount,
      discountPercent: calculated.discountPercent,
      taxCodeId: line.taxCodeId,
      taxRate: calculated.taxRate,
      taxAmount: calculated.taxAmount,
      subtotal: calculated.subtotal,
      baseSubtotal: calculated.baseSubtotal,
      baseTaxAmount: calculated.baseTaxAmount,
      accountId,
    }
  })

  return {
    accountingPeriodId: Number(period.id),
    warehouseId,
    totals,
    lines,
  }
}

export function importedStatus(importAs: 'draft' | 'submitted') {
  return importAs === 'submitted' ? ('pending_approval' as const) : ('draft' as const)
}

export function duplicateInvoiceError(kind: InvoiceKind, invoiceNumber: string) {
  return new ConflictError(
    `${kind === 'sales' ? 'Invoice penjualan' : 'Invoice pembelian'} ${invoiceNumber} sudah ada`,
  )
}
