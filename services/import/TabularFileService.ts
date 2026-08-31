import ExcelJS from 'exceljs'
import { parse as parseCsv } from 'csv-parse/sync'
import { stringify as stringifyCsv } from 'csv-stringify/sync'

import { ValidationError } from '../../utils/AppError'
import {
  allColumns,
  getImportDefinition,
  type ImportType,
} from './ImportDefinitions'

export const MAX_IMPORT_FILE_SIZE = 5 * 1024 * 1024
export const MAX_IMPORT_ROWS = 10_000
export const MAX_IMPORT_COLUMNS = 100

export interface ImportFileLike {
  name: string
  type?: string
  size: number
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface ParsedImportRow {
  rowNumber: number
  data: Record<string, unknown>
}

export interface ParsedTabularFile {
  headers: string[]
  rows: ParsedImportRow[]
  warnings: string[]
}

const allowedCsvMime = new Set([
  '',
  'text/csv',
  'text/plain',
  'application/csv',
  'application/vnd.ms-excel',
  'application/octet-stream',
])
const allowedXlsxMime = new Set([
  '',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
  'application/zip',
])

export function normalizeHeader(value: unknown) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s./-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

function validateHeaders(headers: string[], type: ImportType) {
  if (headers.length === 0) throw new ValidationError('File tidak memiliki header')
  if (headers.length > MAX_IMPORT_COLUMNS) {
    throw new ValidationError(`Maksimum ${MAX_IMPORT_COLUMNS} kolom per file`)
  }
  if (headers.some((header) => !header)) {
    throw new ValidationError('Header kolom tidak boleh kosong')
  }
  const duplicates = headers.filter((header, index) => headers.indexOf(header) !== index)
  if (duplicates.length) {
    throw new ValidationError(`Header duplikat: ${[...new Set(duplicates)].join(', ')}`)
  }

  const definition = getImportDefinition(type)
  const allowed = new Set(allColumns(definition))
  const missing = definition.requiredColumns.filter((column) => !headers.includes(column))
  if (missing.length) throw new ValidationError(`Kolom wajib tidak ditemukan: ${missing.join(', ')}`)
  const unexpected = headers.filter((header) => !allowed.has(header))
  if (unexpected.length) {
    throw new ValidationError(`Kolom tidak dikenali: ${unexpected.join(', ')}`)
  }
}

function assertRowLimit(rows: ParsedImportRow[]) {
  if (rows.length === 0) throw new ValidationError('File tidak memiliki baris data')
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new ValidationError(`Maksimum ${MAX_IMPORT_ROWS.toLocaleString('id-ID')} baris per file`)
  }
}

function parseCsvFile(buffer: Uint8Array, type: ImportType): ParsedTabularFile {
  if (buffer.includes(0)) throw new ValidationError('CSV mengandung data biner yang tidak valid')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new ValidationError('CSV harus menggunakan encoding UTF-8')
  }

  let normalizedHeaders: string[] = []
  try {
    const records = parseCsv(text, {
      bom: true,
      columns: (headers: string[]) => {
        normalizedHeaders = headers.map(normalizeHeader)
        validateHeaders(normalizedHeaders, type)
        return normalizedHeaders
      },
      delimiter: [',', ';', '\t'],
      info: true,
      max_record_size: 128_000,
      relax_column_count: false,
      skip_empty_lines: true,
      trim: true,
    }) as unknown as Array<{
      record: Record<string, string>
      info: { lines: number }
    }>
    const rows = records.map(({ record, info }, index) => ({
      rowNumber: Number(info?.lines ?? index + 2),
      data: record,
    }))
    assertRowLimit(rows)
    return { headers: normalizedHeaders, rows, warnings: [] }
  } catch (error) {
    if (error instanceof ValidationError) throw error
    throw new ValidationError('CSV rusak atau memiliki jumlah kolom yang tidak konsisten')
  }
}

function excelSerialToDate(value: number, date1904: boolean) {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)
  const date = new Date(epoch + Math.floor(value) * 86_400_000)
  return Number.isNaN(date.valueOf()) ? value : date.toISOString().slice(0, 10)
}

function excelValue(value: unknown, header: string, date1904: boolean): unknown {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'number' && (header.endsWith('_date') || header === 'as_of_date')) {
    return excelSerialToDate(value, date1904)
  }
  if (typeof value !== 'object') return value

  const object = value as Record<string, unknown>
  if ('formula' in object || 'sharedFormula' in object) {
    throw new ValidationError('Formula Excel tidak diizinkan; gunakan nilai statis')
  }
  if ('error' in object) throw new ValidationError('File Excel mengandung nilai error')
  if (Array.isArray(object.richText)) {
    return object.richText
      .map((part) => String((part as Record<string, unknown>).text ?? ''))
      .join('')
  }
  if ('text' in object) return String(object.text ?? '')
  if ('result' in object) return object.result
  throw new ValidationError('File Excel mengandung tipe sel yang tidak didukung')
}

async function parseXlsxFile(buffer: Uint8Array, type: ImportType): Promise<ParsedTabularFile> {
  if (!(buffer[0] === 0x50 && buffer[1] === 0x4b)) {
    throw new ValidationError('Signature file XLSX tidak valid')
  }

  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer)
  } catch (error) {
    if (error instanceof ValidationError) throw error
    throw new ValidationError('Workbook XLSX rusak atau tidak dapat dibaca')
  }

  const nonEmptySheets = workbook.worksheets.filter(
    (sheet) => sheet.actualRowCount > 0 && sheet.actualColumnCount > 0,
  )
  const sheet = nonEmptySheets[0]
  if (!sheet) throw new ValidationError('Workbook tidak memiliki worksheet berisi data')
  if (sheet.actualColumnCount > MAX_IMPORT_COLUMNS) {
    throw new ValidationError(`Maksimum ${MAX_IMPORT_COLUMNS} kolom per file`)
  }

  const rawHeaders: unknown[] = []
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, columnNumber) => {
    rawHeaders[columnNumber - 1] = excelValue(
      cell.value,
      '',
      Boolean(workbook.properties.date1904),
    )
  })
  while (rawHeaders.length && String(rawHeaders.at(-1) ?? '').trim() === '') rawHeaders.pop()
  const headers = rawHeaders.map(normalizeHeader)
  validateHeaders(headers, type)

  const rows: ParsedImportRow[] = []
  for (let rowNumber = 2; rowNumber <= sheet.actualRowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber)
    const data: Record<string, unknown> = {}
    let hasValue = false
    for (const [index, header] of headers.entries()) {
      const value = excelValue(
        row.getCell(index + 1).value,
        header,
        Boolean(workbook.properties.date1904),
      )
      data[header] = value
      if (String(value ?? '').trim() !== '') hasValue = true
    }
    if (hasValue) rows.push({ rowNumber, data })
    if (rows.length > MAX_IMPORT_ROWS) assertRowLimit(rows)
  }
  assertRowLimit(rows)
  return {
    headers,
    rows,
    warnings:
      nonEmptySheets.length > 1
        ? [`Hanya worksheet '${sheet.name}' yang diproses; worksheet lain diabaikan.`]
        : [],
  }
}

export async function parseImportFile(
  file: ImportFileLike,
  type: ImportType,
): Promise<{ parsed: ParsedTabularFile; buffer: Uint8Array; extension: 'csv' | 'xlsx' }> {
  const safeName = file.name.replace(/[\\/\u0000-\u001F]/g, '_').slice(0, 255)
  const extension = safeName.toLowerCase().endsWith('.csv')
    ? 'csv'
    : safeName.toLowerCase().endsWith('.xlsx')
      ? 'xlsx'
      : null
  if (!extension) throw new ValidationError('Format file harus CSV atau XLSX')
  if (file.size <= 0) throw new ValidationError('File kosong')
  if (file.size > MAX_IMPORT_FILE_SIZE) {
    throw new ValidationError('Ukuran file maksimum 5 MB')
  }
  const mime = (file.type ?? '').toLowerCase().split(';')[0] ?? ''
  if (extension === 'csv' && !allowedCsvMime.has(mime)) {
    throw new ValidationError('MIME type CSV tidak valid')
  }
  if (extension === 'xlsx' && !allowedXlsxMime.has(mime)) {
    throw new ValidationError('MIME type XLSX tidak valid')
  }

  const buffer = new Uint8Array(await file.arrayBuffer())
  if (buffer.byteLength !== file.size) throw new ValidationError('Ukuran file tidak konsisten')
  const parsed =
    extension === 'csv' ? parseCsvFile(buffer, type) : await parseXlsxFile(buffer, type)
  return { parsed, buffer, extension }
}

export function safeSpreadsheetValue(value: unknown) {
  const text = String(value ?? '')
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
}

export async function createImportTemplate(type: ImportType, format: 'csv' | 'xlsx') {
  const definition = getImportDefinition(type)
  const headers = allColumns(definition)
  const row = headers.map((header) => safeSpreadsheetValue(definition.sample[header] ?? ''))
  if (format === 'csv') {
    const content = stringifyCsv([headers, row], { bom: true, record_delimiter: 'windows' })
    return {
      content: Buffer.from(content, 'utf8'),
      contentType: 'text/csv; charset=utf-8',
      filename: `template-${type}.csv`,
    }
  }

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Finora ERP'
  workbook.created = new Date()
  const sheet = workbook.addWorksheet('Import')
  sheet.addRow(headers)
  sheet.addRow(row)
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
  const headerRow = sheet.getRow(1)
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } }
  headerRow.alignment = { vertical: 'middle' }
  headerRow.height = 24
  for (const [index, header] of headers.entries()) {
    sheet.getColumn(index + 1).width = Math.min(42, Math.max(14, header.length + 3))
  }
  sheet.autoFilter = { from: 'A1', to: `${sheet.getColumn(headers.length).letter}1` }
  const content = Buffer.from(await workbook.xlsx.writeBuffer())
  return {
    content,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    filename: `template-${type}.xlsx`,
  }
}

export async function createErrorReport(
  rows: Array<{
    rowNumber: number
    field: string | null
    value: string | null
    severity: 'warning' | 'error'
    code: string | null
    message: string
  }>,
  format: 'csv' | 'xlsx',
  importNumber: string,
) {
  const headers = ['row_number', 'field', 'value', 'severity', 'error_code', 'error_message']
  const values = rows.map((row) => [
    row.rowNumber,
    row.field ?? '',
    safeSpreadsheetValue(row.value),
    row.severity,
    row.code ?? '',
    safeSpreadsheetValue(row.message),
  ])
  if (format === 'csv') {
    return {
      content: Buffer.from(
        stringifyCsv([headers, ...values], { bom: true, record_delimiter: 'windows' }),
        'utf8',
      ),
      contentType: 'text/csv; charset=utf-8',
      filename: `${importNumber}-errors.csv`,
    }
  }
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Errors')
  sheet.addRow(headers)
  for (const value of values) sheet.addRow(value)
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
  sheet.getRow(1).font = { bold: true }
  sheet.getColumn(1).width = 14
  sheet.getColumn(2).width = 24
  sheet.getColumn(3).width = 28
  sheet.getColumn(4).width = 14
  sheet.getColumn(5).width = 24
  sheet.getColumn(6).width = 60
  return {
    content: Buffer.from(await workbook.xlsx.writeBuffer()),
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    filename: `${importNumber}-errors.xlsx`,
  }
}
