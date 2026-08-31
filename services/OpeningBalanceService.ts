import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'

import type { QueryExecutor } from '../types/database'
import { ConflictError, ValidationError } from '../utils/AppError'
import {
  addDecimal,
  compareDecimal,
  multiplyDecimal,
  normalizeDecimal,
  type DecimalInput,
} from '../utils/decimal'
import { AuditService } from './AuditService'
import { BusinessValidationService } from './BusinessValidationService'
import { InventoryCostingService } from './InventoryCostingService'
import { assertBalanced } from './PostingService'

export type OpeningBalanceStatus = 'draft' | 'validated'

export interface OpeningBalanceContext {
  userId: number
  requestId?: string | null
  ip?: string | null
}

export interface GeneralLedgerOpeningLineInput {
  lineNumber?: number
  accountId: number
  debit: DecimalInput
  credit: DecimalInput
  currency?: string
  exchangeRate?: DecimalInput
  documentNumber?: string | null
  documentDate?: string | null
  dueDate?: string | null
  lineType?: 'general_ledger' | 'receivable' | 'payable'
  customerId?: number | null
  supplierId?: number | null
  notes?: string | null
}

export interface GeneralLedgerOpeningInput {
  companyId: number
  batchNumber: string
  asOfDate: string
  description?: string | null
  balanceType?: 'general_ledger' | 'receivable' | 'payable' | 'mixed'
  status?: OpeningBalanceStatus
  lines: GeneralLedgerOpeningLineInput[]
}

export interface InventoryOpeningLineInput {
  lineNumber?: number
  itemId: number
  warehouseId: number
  quantity: DecimalInput
  unitCost: DecimalInput
  currency?: string
  exchangeRate?: DecimalInput
  documentNumber?: string | null
  notes?: string | null
}

export interface InventoryOpeningInput {
  companyId: number
  batchNumber: string
  asOfDate: string
  description?: string | null
  status?: OpeningBalanceStatus
  lines: InventoryOpeningLineInput[]
}

export interface GeneralLedgerOpeningResult {
  id: number
  batchNumber: string
  status: OpeningBalanceStatus
  lineCount: number
  totalDebit: string
  totalCredit: string
}

export interface InventoryOpeningResult {
  id: number
  batchNumber: string
  status: OpeningBalanceStatus
  lineCount: number
  movementCount: number
  totalValue: string
}

interface PreparedGeneralLedgerLine {
  lineNumber: number
  accountId: number
  debit: string
  credit: string
  currency: string
  exchangeRate: string
  documentNumber: string | null
  documentDate: string | null
  dueDate: string | null
  lineType: 'general_ledger' | 'receivable' | 'payable'
  customerId: number | null
  supplierId: number | null
  notes: string | null
}

interface PreparedInventoryLine {
  lineNumber: number
  itemId: number
  warehouseId: number
  quantity: string
  unitCost: string
  amount: string
  currency: string
  exchangeRate: string
  documentNumber: string | null
  notes: string | null
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function positiveId(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError(`${label} tidak valid`)
  }
  return value
}

function dateOnly(value: string, label: string) {
  if (typeof value !== 'string') throw new ValidationError(`${label} tidak valid`)
  const normalized = value.trim()
  if (!ISO_DATE_PATTERN.test(normalized)) throw new ValidationError(`${label} tidak valid`)
  const parsed = new Date(`${normalized}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new ValidationError(`${label} tidak valid`)
  }
  return normalized
}

function optionalDate(value: string | null | undefined, label: string) {
  return value === undefined || value === null || value.trim() === ''
    ? null
    : dateOnly(value, label)
}

function limitedText(
  value: string | null | undefined,
  label: string,
  maximum: number,
  required = false,
) {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${label} wajib diisi`)
    return null
  }
  const normalized = value.trim()
  if (!normalized) {
    if (required) throw new ValidationError(`${label} wajib diisi`)
    return null
  }
  if (normalized.length > maximum) {
    throw new ValidationError(`${label} maksimal ${maximum} karakter`)
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ValidationError(`${label} mengandung karakter yang tidak diizinkan`)
  }
  return normalized
}

function documentNumber(value: string, label: string, maximum: number) {
  return limitedText(value, label, maximum, true) as string
}

function currency(value: string | undefined) {
  if (value !== undefined && typeof value !== 'string') {
    throw new ValidationError('Kode mata uang tidak valid')
  }
  const normalized = (value ?? 'IDR').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(normalized)) throw new ValidationError('Kode mata uang tidak valid')
  return normalized
}

function decimal(value: DecimalInput, label: string, scale = 2) {
  try {
    return normalizeDecimal(value, scale)
  } catch {
    throw new ValidationError(`${label} tidak valid`)
  }
}

function exchangeRate(value: DecimalInput | undefined, label: string) {
  const normalized = decimal(value ?? '1', label, 8)
  if (compareDecimal(normalized, '0', 8) <= 0) {
    throw new ValidationError('Kurs harus lebih dari nol')
  }
  return normalized
}

function lineNumber(value: number | undefined, index: number) {
  return positiveId(value ?? index + 1, `Nomor baris ${index + 1}`)
}

function assertUniqueLineNumbers(lines: Array<{ lineNumber: number }>) {
  const seen = new Set<number>()
  for (const line of lines) {
    if (seen.has(line.lineNumber)) {
      throw new ConflictError(`Nomor baris ${line.lineNumber} duplikat dalam batch`)
    }
    seen.add(line.lineNumber)
  }
}

export class OpeningBalanceService {
  constructor(
    private readonly validation = new BusinessValidationService(),
    private readonly inventory = new InventoryCostingService(),
    private readonly audit = new AuditService(),
  ) {}

  /**
   * Persists a balanced general-ledger opening batch using the caller's transaction.
   * This method intentionally does not create or post a journal.
   */
  async createGeneralLedger(
    connection: QueryExecutor,
    input: GeneralLedgerOpeningInput,
    context: OpeningBalanceContext,
  ): Promise<GeneralLedgerOpeningResult> {
    const companyId = positiveId(input.companyId, 'Perusahaan')
    const userId = positiveId(context.userId, 'Pengguna')
    const batchNumber = documentNumber(input.batchNumber, 'Nomor batch', 50)
    const asOfDate = dateOnly(input.asOfDate, 'Tanggal saldo awal')
    const description = limitedText(input.description, 'Deskripsi', 5000)
    const status = input.status ?? 'draft'
    if (status !== 'draft' && status !== 'validated') {
      throw new ValidationError('Status saldo awal tidak valid')
    }

    const lines = input.lines.map<PreparedGeneralLedgerLine>((line, index) => ({
      lineNumber: lineNumber(line.lineNumber, index),
      accountId: positiveId(line.accountId, `Akun baris ${index + 1}`),
      debit: decimal(line.debit, `Debit baris ${index + 1}`),
      credit: decimal(line.credit, `Kredit baris ${index + 1}`),
      currency: currency(line.currency),
      exchangeRate: exchangeRate(line.exchangeRate, `Kurs baris ${index + 1}`),
      documentNumber: limitedText(line.documentNumber, `Nomor dokumen baris ${index + 1}`, 100),
      documentDate: optionalDate(line.documentDate, `Tanggal dokumen baris ${index + 1}`),
      dueDate: optionalDate(line.dueDate, `Jatuh tempo baris ${index + 1}`),
      lineType: line.lineType ?? 'general_ledger',
      customerId: line.customerId ? positiveId(line.customerId, `Pelanggan baris ${index + 1}`) : null,
      supplierId: line.supplierId ? positiveId(line.supplierId, `Pemasok baris ${index + 1}`) : null,
      notes: limitedText(line.notes, `Catatan baris ${index + 1}`, 500),
    }))

    assertUniqueLineNumbers(lines)
    for (const [index, line] of lines.entries()) {
      if (line.lineType === 'receivable' && !line.customerId) {
        throw new ValidationError(`Pelanggan baris ${index + 1} wajib diisi`)
      }
      if (line.lineType === 'payable' && !line.supplierId) {
        throw new ValidationError(`Pemasok baris ${index + 1} wajib diisi`)
      }
      if (line.lineType === 'general_ledger' && (line.customerId || line.supplierId)) {
        throw new ValidationError(`Pihak tidak boleh diisi pada baris general ledger ${index + 1}`)
      }
    }
    const totals = assertBalanced(
      lines.map((line) => ({
        accountId: line.accountId,
        debit: line.debit,
        credit: line.credit,
      })),
    )

    await this.assertBatchNumberAvailable(connection, companyId, batchNumber)
    for (const line of lines) {
      await this.validation.ensureActiveReference(connection, {
        table: 'accounts',
        id: line.accountId,
        companyId,
        label: `Akun baris ${line.lineNumber}`,
        postingOnly: true,
      })
      if (line.customerId) {
        await this.validation.ensureActiveReference(connection, {
          table: 'customers',
          id: line.customerId,
          companyId,
          label: `Pelanggan baris ${line.lineNumber}`,
        })
      }
      if (line.supplierId) {
        await this.validation.ensureActiveReference(connection, {
          table: 'suppliers',
          id: line.supplierId,
          companyId,
          label: `Pemasok baris ${line.lineNumber}`,
        })
      }
    }

    const batchId = await this.insertBatch(connection, {
      companyId,
      batchNumber,
      asOfDate,
      balanceType: input.balanceType ?? 'general_ledger',
      description,
      totalDebit: totals.totalDebit,
      totalCredit: totals.totalCredit,
      status,
      userId,
    })

    for (const line of lines) {
      await connection.execute(
        `INSERT INTO opening_balance_lines (
           opening_balance_batch_id, line_number, line_type, account_id, customer_id, supplier_id,
           document_number, document_date, due_date, currency, exchange_rate,
           debit, credit, amount, notes
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          batchId,
          line.lineNumber,
          line.lineType,
          line.accountId,
          line.customerId,
          line.supplierId,
          line.documentNumber,
          line.documentDate,
          line.dueDate,
          line.currency,
          line.exchangeRate,
          line.debit,
          line.credit,
          compareDecimal(line.debit, '0') > 0 ? line.debit : line.credit,
          line.notes,
        ],
      )
    }

    await this.audit.log(connection, {
      companyId,
      userId,
      module: 'opening-balances',
      action: status === 'validated' ? 'validate' : 'create',
      recordType: 'opening_balance_batch',
      recordId: batchId,
      recordNumber: batchNumber,
      newValue: {
        balanceType: input.balanceType ?? 'general_ledger',
        asOfDate,
        status,
        lineCount: lines.length,
        totalDebit: totals.totalDebit,
        totalCredit: totals.totalCredit,
      },
      requestId: context.requestId,
      ip: context.ip,
    })

    return {
      id: batchId,
      batchNumber,
      status,
      lineCount: lines.length,
      totalDebit: totals.totalDebit,
      totalCredit: totals.totalCredit,
    }
  }

  /**
   * Persists an inventory opening batch using the caller's transaction. Draft batches
   * do not affect stock. Explicitly validated batches create inventory movements via
   * InventoryCostingService; this service never writes inventory_balances directly.
   */
  async createInventory(
    connection: QueryExecutor,
    input: InventoryOpeningInput,
    context: OpeningBalanceContext,
  ): Promise<InventoryOpeningResult> {
    const companyId = positiveId(input.companyId, 'Perusahaan')
    const userId = positiveId(context.userId, 'Pengguna')
    const batchNumber = documentNumber(input.batchNumber, 'Nomor batch', 50)
    const asOfDate = dateOnly(input.asOfDate, 'Tanggal saldo awal persediaan')
    const description = limitedText(input.description, 'Deskripsi', 5000)
    const status = input.status ?? 'draft'
    if (status !== 'draft' && status !== 'validated') {
      throw new ValidationError('Status saldo awal tidak valid')
    }
    if (input.lines.length === 0) {
      throw new ValidationError('Saldo awal persediaan minimal mempunyai satu baris')
    }

    const lines = input.lines.map<PreparedInventoryLine>((line, index) => {
      const quantity = decimal(line.quantity, `Kuantitas baris ${index + 1}`, 4)
      const unitCost = decimal(line.unitCost, `Biaya unit baris ${index + 1}`, 6)
      if (compareDecimal(quantity, '0', 4) <= 0) {
        throw new ValidationError(`Kuantitas baris ${index + 1} harus lebih dari nol`)
      }
      if (compareDecimal(unitCost, '0', 6) < 0) {
        throw new ValidationError(`Biaya unit baris ${index + 1} tidak boleh negatif`)
      }
      return {
        lineNumber: lineNumber(line.lineNumber, index),
        itemId: positiveId(line.itemId, `Barang baris ${index + 1}`),
        warehouseId: positiveId(line.warehouseId, `Gudang baris ${index + 1}`),
        quantity,
        unitCost,
        amount: multiplyDecimal(quantity, 4, unitCost, 6, 2),
        currency: currency(line.currency),
        exchangeRate: exchangeRate(line.exchangeRate, `Kurs baris ${index + 1}`),
        documentNumber: limitedText(line.documentNumber, `Nomor dokumen baris ${index + 1}`, 100),
        notes: limitedText(line.notes, `Catatan baris ${index + 1}`, 500),
      }
    })

    assertUniqueLineNumbers(lines)
    const inventoryKeys = new Set<string>()
    for (const line of lines) {
      const key = `${line.itemId}:${line.warehouseId}`
      if (inventoryKeys.has(key)) {
        throw new ConflictError(
          `Barang dan gudang pada baris ${line.lineNumber} duplikat dalam batch`,
        )
      }
      inventoryKeys.add(key)
    }

    await this.assertBatchNumberAvailable(connection, companyId, batchNumber)
    for (const line of lines) {
      await this.validation.ensureActiveReference(connection, {
        table: 'items',
        id: line.itemId,
        companyId,
        label: `Barang baris ${line.lineNumber}`,
      })
      await this.validation.ensureActiveReference(connection, {
        table: 'warehouses',
        id: line.warehouseId,
        companyId,
        label: `Gudang baris ${line.lineNumber}`,
      })
      const [items] = await connection.execute<RowDataPacket[]>(
        `SELECT item_type
         FROM items
         WHERE id = ? AND company_id = ? AND deleted_at IS NULL
         LIMIT 1
         FOR UPDATE`,
        [line.itemId, companyId],
      )
      if (items[0]?.item_type !== 'inventory') {
        throw new ValidationError(`Barang baris ${line.lineNumber} bukan barang persediaan`)
      }
      const [movements] = await connection.execute<RowDataPacket[]>(
        `SELECT id
         FROM inventory_movements
         WHERE company_id = ? AND item_id = ? AND warehouse_id = ?
         LIMIT 1`,
        [companyId, line.itemId, line.warehouseId],
      )
      if (movements[0]) {
        throw new ConflictError(
          `Saldo awal baris ${line.lineNumber} tidak dapat dibuat karena barang sudah mempunyai pergerakan stok di gudang tersebut`,
        )
      }
    }

    const totalValue = lines.reduce((total, line) => addDecimal([total, line.amount]), '0.00')
    const batchId = await this.insertBatch(connection, {
      companyId,
      batchNumber,
      asOfDate,
      balanceType: 'inventory',
      description,
      totalDebit: '0.00',
      totalCredit: '0.00',
      status,
      userId,
    })

    let movementCount = 0
    for (const line of lines) {
      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO opening_balance_lines (
           opening_balance_batch_id, line_number, line_type, item_id, warehouse_id,
           document_number, document_date, currency, exchange_rate,
           quantity, unit_cost, amount, notes
         ) VALUES (?, ?, 'inventory', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          batchId,
          line.lineNumber,
          line.itemId,
          line.warehouseId,
          line.documentNumber,
          asOfDate,
          line.currency,
          line.exchangeRate,
          line.quantity,
          line.unitCost,
          line.amount,
          line.notes,
        ],
      )

      if (status === 'validated') {
        await this.inventory.applyMovement(connection, {
          companyId,
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          direction: 'in',
          quantity: line.quantity,
          unitCost: line.unitCost,
          transactionType: 'opening_balance',
          transactionId: batchId,
          sourceLineId: result.insertId,
          transactionNumber: batchNumber,
          movementDate: asOfDate,
          reference: line.documentNumber,
          postingKey: `opening-balance:${companyId}:${batchId}:${line.lineNumber}`,
          userId,
        })
        movementCount += 1
      }
    }

    await this.audit.log(connection, {
      companyId,
      userId,
      module: 'opening-balances',
      action: status === 'validated' ? 'validate' : 'create',
      recordType: 'opening_balance_batch',
      recordId: batchId,
      recordNumber: batchNumber,
      newValue: {
        balanceType: 'inventory',
        asOfDate,
        status,
        lineCount: lines.length,
        movementCount,
        totalValue,
      },
      requestId: context.requestId,
      ip: context.ip,
    })

    return {
      id: batchId,
      batchNumber,
      status,
      lineCount: lines.length,
      movementCount,
      totalValue,
    }
  }

  private async assertBatchNumberAvailable(
    connection: QueryExecutor,
    companyId: number,
    batchNumber: string,
  ) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT id
       FROM opening_balance_batches
       WHERE company_id = ? AND batch_number = ?
       LIMIT 1`,
      [companyId, batchNumber],
    )
    if (rows[0]) throw new ConflictError(`Nomor batch ${batchNumber} sudah digunakan`)
  }

  private async insertBatch(
    connection: QueryExecutor,
    input: {
      companyId: number
      batchNumber: string
      asOfDate: string
      balanceType: 'general_ledger' | 'receivable' | 'payable' | 'inventory' | 'mixed'
      description: string | null
      totalDebit: string
      totalCredit: string
      status: OpeningBalanceStatus
      userId: number
    },
  ) {
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO opening_balance_batches (
         company_id, batch_number, as_of_date, balance_type, description,
         total_debit, total_credit, status, created_by, validated_by, validated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.companyId,
        input.batchNumber,
        input.asOfDate,
        input.balanceType,
        input.description,
        input.totalDebit,
        input.totalCredit,
        input.status,
        input.userId,
        input.status === 'validated' ? input.userId : null,
        input.status === 'validated' ? new Date() : null,
      ],
    )
    return result.insertId
  }
}
