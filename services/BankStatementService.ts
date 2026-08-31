import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'

import type { QueryExecutor } from '../types/database'
import { ConflictError, ValidationError } from '../utils/AppError'
import {
  addDecimal,
  compareDecimal,
  normalizeDecimal,
  subtractDecimal,
  type DecimalInput,
} from '../utils/decimal'
import { AuditService } from './AuditService'
import { BusinessValidationService } from './BusinessValidationService'

export type BankStatementStatus = 'draft' | 'imported'
export type BankBalanceConvention = 'auto' | 'debit_increases' | 'credit_increases' | 'reported'

export interface BankStatementContext {
  userId: number
  requestId?: string | null
  ip?: string | null
}

export interface BankStatementLineInput {
  lineNumber?: number
  transactionDate: string
  description: string
  reference?: string | null
  debit: DecimalInput
  credit: DecimalInput
  balance: DecimalInput
  externalId?: string | null
}

export interface BankStatementInput {
  companyId: number
  bankAccountId: number
  statementNumber: string
  periodStart: string
  periodEnd: string
  openingBalance: DecimalInput
  closingBalance: DecimalInput
  status?: BankStatementStatus
  balanceConvention?: BankBalanceConvention
  fileName?: string | null
  checksum?: string | null
  lines: BankStatementLineInput[]
}

export interface BankStatementResult {
  id: number
  statementNumber: string
  status: BankStatementStatus
  lineCount: number
  openingBalance: string
  closingBalance: string
  balanceConvention: BankBalanceConvention
}

interface PreparedBankStatementLine {
  lineNumber: number
  transactionDate: string
  description: string
  reference: string | null
  debit: string
  credit: string
  balance: string
  externalId: string | null
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

function lineNumber(value: number | undefined, index: number) {
  return positiveId(value ?? index + 1, `Nomor baris ${index + 1}`)
}

function decimal(value: DecimalInput, label: string) {
  try {
    return normalizeDecimal(value)
  } catch {
    throw new ValidationError(`${label} tidak valid`)
  }
}

function expectedBalance(
  previous: string,
  line: PreparedBankStatementLine,
  convention: 'debit_increases' | 'credit_increases',
) {
  return convention === 'debit_increases'
    ? subtractDecimal(addDecimal([previous, line.debit]), line.credit)
    : subtractDecimal(addDecimal([previous, line.credit]), line.debit)
}

function followsConvention(
  openingBalance: string,
  lines: PreparedBankStatementLine[],
  convention: 'debit_increases' | 'credit_increases',
) {
  let running = openingBalance
  for (const line of lines) {
    running = expectedBalance(running, line, convention)
    if (compareDecimal(running, line.balance) !== 0) return false
  }
  return true
}

export class BankStatementService {
  constructor(
    private readonly validation = new BusinessValidationService(),
    private readonly audit = new AuditService(),
  ) {}

  /** Creates a statement and its unmatched lines using the caller's transaction. */
  async create(
    connection: QueryExecutor,
    input: BankStatementInput,
    context: BankStatementContext,
  ): Promise<BankStatementResult> {
    const companyId = positiveId(input.companyId, 'Perusahaan')
    const bankAccountId = positiveId(input.bankAccountId, 'Rekening bank')
    const userId = positiveId(context.userId, 'Pengguna')
    const statementNumber = limitedText(
      input.statementNumber,
      'Nomor rekening koran',
      100,
      true,
    ) as string
    const periodStart = dateOnly(input.periodStart, 'Tanggal awal periode')
    const periodEnd = dateOnly(input.periodEnd, 'Tanggal akhir periode')
    if (periodEnd < periodStart) {
      throw new ValidationError('Tanggal akhir periode tidak boleh sebelum tanggal awal')
    }
    if (input.lines.length === 0) {
      throw new ValidationError('Rekening koran minimal mempunyai satu baris')
    }

    const openingBalance = decimal(input.openingBalance, 'Saldo awal')
    const closingBalance = decimal(input.closingBalance, 'Saldo akhir')
    const status = input.status ?? 'imported'
    if (status !== 'draft' && status !== 'imported') {
      throw new ValidationError('Status rekening koran tidak valid')
    }
    const requestedConvention = input.balanceConvention ?? 'auto'
    if (
      requestedConvention !== 'auto' &&
      requestedConvention !== 'debit_increases' &&
      requestedConvention !== 'credit_increases' &&
      requestedConvention !== 'reported'
    ) {
      throw new ValidationError('Konvensi saldo rekening koran tidak valid')
    }
    const fileName = limitedText(input.fileName, 'Nama file', 255)
    const checksum = limitedText(input.checksum, 'Checksum file', 128)

    const seenLineNumbers = new Set<number>()
    const seenExternalIds = new Set<string>()
    const lines = input.lines.map<PreparedBankStatementLine>((line, index) => {
      const prepared: PreparedBankStatementLine = {
        lineNumber: lineNumber(line.lineNumber, index),
        transactionDate: dateOnly(line.transactionDate, `Tanggal transaksi baris ${index + 1}`),
        description: limitedText(
          line.description,
          `Deskripsi baris ${index + 1}`,
          500,
          true,
        ) as string,
        reference: limitedText(line.reference, `Referensi baris ${index + 1}`, 191),
        debit: decimal(line.debit, `Debit baris ${index + 1}`),
        credit: decimal(line.credit, `Kredit baris ${index + 1}`),
        balance: decimal(line.balance, `Saldo baris ${index + 1}`),
        externalId: limitedText(line.externalId, `External ID baris ${index + 1}`, 191),
      }

      if (prepared.transactionDate < periodStart || prepared.transactionDate > periodEnd) {
        throw new ValidationError(`Tanggal transaksi baris ${index + 1} berada di luar periode`)
      }
      const debitPositive = compareDecimal(prepared.debit, '0') > 0
      const creditPositive = compareDecimal(prepared.credit, '0') > 0
      if (compareDecimal(prepared.debit, '0') < 0 || compareDecimal(prepared.credit, '0') < 0) {
        throw new ValidationError(`Debit dan kredit baris ${index + 1} tidak boleh negatif`)
      }
      if (debitPositive === creditPositive) {
        throw new ValidationError(`Baris ${index + 1} harus memiliki debit atau kredit saja`)
      }
      if (seenLineNumbers.has(prepared.lineNumber)) {
        throw new ConflictError(`Nomor baris ${prepared.lineNumber} duplikat dalam rekening koran`)
      }
      seenLineNumbers.add(prepared.lineNumber)
      if (prepared.externalId) {
        if (seenExternalIds.has(prepared.externalId)) {
          throw new ConflictError(`External ID ${prepared.externalId} duplikat dalam file`)
        }
        seenExternalIds.add(prepared.externalId)
      }
      return prepared
    })

    if (compareDecimal(lines.at(-1)!.balance, closingBalance) !== 0) {
      throw new ValidationError('Saldo baris terakhir tidak sama dengan saldo penutupan')
    }

    const debitIncreases = followsConvention(openingBalance, lines, 'debit_increases')
    const creditIncreases = followsConvention(openingBalance, lines, 'credit_increases')
    let balanceConvention = requestedConvention
    if (requestedConvention === 'auto') {
      if (!debitIncreases && !creditIncreases) {
        throw new ValidationError('Urutan saldo berjalan tidak konsisten dengan debit dan kredit')
      }
      balanceConvention = debitIncreases ? 'debit_increases' : 'credit_increases'
    } else if (
      requestedConvention !== 'reported' &&
      !followsConvention(openingBalance, lines, requestedConvention)
    ) {
      throw new ValidationError('Urutan saldo berjalan tidak sesuai konvensi debit/kredit')
    }

    await this.validation.ensureActiveReference(connection, {
      table: 'bank_accounts',
      id: bankAccountId,
      companyId,
      label: 'Rekening bank',
    })
    await connection.execute(
      `SELECT id
       FROM bank_accounts
       WHERE id = ? AND company_id = ?
       FOR UPDATE`,
      [bankAccountId, companyId],
    )
    await this.assertStatementAvailable(connection, {
      companyId,
      bankAccountId,
      statementNumber,
      periodStart,
      periodEnd,
      checksum,
      externalIds: [...seenExternalIds],
    })

    const [header] = await connection.execute<ResultSetHeader>(
      `INSERT INTO bank_statements (
         company_id, bank_account_id, statement_number, period_start, period_end,
         opening_balance, closing_balance, status, import_file_name, import_checksum,
         imported_by, imported_at, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        companyId,
        bankAccountId,
        statementNumber,
        periodStart,
        periodEnd,
        openingBalance,
        closingBalance,
        status,
        fileName,
        checksum,
        userId,
        new Date(),
        userId,
      ],
    )
    const statementId = header.insertId

    for (const line of lines) {
      await connection.execute(
        `INSERT INTO bank_statement_lines (
           bank_statement_id, line_number, transaction_date, description,
           reference, debit, credit, balance, external_id,
           reconciliation_status, matched_amount
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unmatched', 0)`,
        [
          statementId,
          line.lineNumber,
          line.transactionDate,
          line.description,
          line.reference,
          line.debit,
          line.credit,
          line.balance,
          line.externalId,
        ],
      )
    }

    await this.audit.log(connection, {
      companyId,
      userId,
      module: 'bank-statements',
      action: 'import',
      recordType: 'bank_statement',
      recordId: statementId,
      recordNumber: statementNumber,
      newValue: {
        bankAccountId,
        periodStart,
        periodEnd,
        status,
        lineCount: lines.length,
        openingBalance,
        closingBalance,
        balanceConvention,
      },
      metadata: fileName ? { fileName } : undefined,
      requestId: context.requestId,
      ip: context.ip,
    })

    return {
      id: statementId,
      statementNumber,
      status,
      lineCount: lines.length,
      openingBalance,
      closingBalance,
      balanceConvention,
    }
  }

  private async assertStatementAvailable(
    connection: QueryExecutor,
    input: {
      companyId: number
      bankAccountId: number
      statementNumber: string
      periodStart: string
      periodEnd: string
      checksum: string | null
      externalIds: string[]
    },
  ) {
    const [headers] = await connection.execute<RowDataPacket[]>(
      `SELECT id, statement_number, import_checksum, period_start, period_end
       FROM bank_statements
       WHERE company_id = ? AND bank_account_id = ?
         AND (
           statement_number = ?
           OR (? IS NOT NULL AND import_checksum = ?)
           OR (period_start <= ? AND period_end >= ?)
         )
       LIMIT 1`,
      [
        input.companyId,
        input.bankAccountId,
        input.statementNumber,
        input.checksum,
        input.checksum,
        input.periodEnd,
        input.periodStart,
      ],
    )
    if (headers[0]) {
      if (headers[0].statement_number === input.statementNumber) {
        throw new ConflictError(`Nomor rekening koran ${input.statementNumber} sudah digunakan`)
      }
      if (input.checksum && headers[0].import_checksum === input.checksum) {
        throw new ConflictError('File rekening koran ini sudah pernah diimpor')
      }
      throw new ConflictError('Periode rekening koran bertumpang tindih dengan data yang sudah ada')
    }

    for (let offset = 0; offset < input.externalIds.length; offset += 500) {
      const chunk = input.externalIds.slice(offset, offset + 500)
      const marks = chunk.map(() => '?').join(', ')
      const [duplicates] = await connection.execute<RowDataPacket[]>(
        `SELECT bsl.external_id
         FROM bank_statement_lines bsl
         INNER JOIN bank_statements bs ON bs.id = bsl.bank_statement_id
         WHERE bs.company_id = ? AND bs.bank_account_id = ?
           AND bsl.external_id IN (${marks})
         LIMIT 1`,
        [input.companyId, input.bankAccountId, ...chunk],
      )
      if (duplicates[0]) {
        throw new ConflictError(
          `External ID ${String(duplicates[0].external_id)} sudah pernah diimpor`,
        )
      }
    }
  }
}
