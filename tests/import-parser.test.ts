import { describe, expect, test } from 'bun:test'

import { IMPORT_TYPES } from '../services/import/ImportDefinitions'
import { ImportValidationService } from '../services/import/ImportValidationService'
import {
  createErrorReport,
  createImportTemplate,
  parseImportFile,
} from '../services/import/TabularFileService'
import { importRowsQuerySchema } from '../validators/import.validator'
import type { QueryExecutor } from '../types/database'

const file = (name: string, content: Uint8Array | Buffer, type = '') => ({
  name,
  type,
  size: content.byteLength,
  arrayBuffer: async () =>
    content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer,
})

describe('data import parser and templates', () => {
  test('accepts the duplicate preview filter exposed by the frontend', () => {
    expect(importRowsQuerySchema.parse({ status: 'duplicate' })).toEqual({
      page: 1,
      limit: 50,
      status: 'duplicate',
    })
  })

  test('parses UTF-8 CSV with BOM, quoted delimiters, and source row numbers', async () => {
    const content = Buffer.from(
      '\uFEFFcustomer_code,customer_name,email\r\nC-001,"PT Contoh, Tbk",finance@example.com\r\n',
      'utf8',
    )
    const result = await parseImportFile(file('customers.csv', content, 'text/csv'), 'customer')
    expect(result.extension).toBe('csv')
    expect(result.parsed.rows).toHaveLength(1)
    expect(result.parsed.rows[0]?.rowNumber).toBe(2)
    expect(result.parsed.rows[0]?.data.customer_name).toBe('PT Contoh, Tbk')
  })

  test('rejects missing required columns and unexpected columns', async () => {
    const missing = Buffer.from('customer_code,unknown\nC-001,value\n')
    await expect(parseImportFile(file('bad.csv', missing, 'text/csv'), 'customer')).rejects.toThrow(
      'Kolom wajib tidak ditemukan',
    )
  })

  test('generates round-trip CSV and XLSX templates for every import type', async () => {
    for (const type of IMPORT_TYPES) {
      for (const format of ['csv', 'xlsx'] as const) {
        const template = await createImportTemplate(type, format)
        const mime =
          format === 'csv'
            ? 'text/csv'
            : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        const parsed = await parseImportFile(file(template.filename, template.content, mime), type)
        expect(parsed.parsed.rows).toHaveLength(1)
      }
    }
  })

  test('escapes spreadsheet formulas in downloadable error reports', async () => {
    const report = await createErrorReport(
      [
        {
          rowNumber: 2,
          field: 'description',
          value: '=HYPERLINK("https://example.invalid")',
          severity: 'error',
          code: 'invalid',
          message: '+unsafe',
        },
      ],
      'csv',
      'IMP-001',
    )
    const text = report.content.toString('utf8')
    expect(text).toContain("'=HYPERLINK")
    expect(text).toContain("'+unsafe")
  })

  test('rejects invalid and cyclic in-file account hierarchies during preview', async () => {
    const emptyCatalog = {
      execute: async () => [[]],
    } as unknown as QueryExecutor
    const validation = new ImportValidationService()

    const invalidParent = await validation.validate(
      1,
      'chart_of_accounts',
      [
        {
          rowNumber: 2,
          data: {
            account_code: '110100',
            account_name: 'Kas',
            account_type: 'asset',
            normal_balance: 'debit',
            parent_code: '110000',
          },
        },
        {
          rowNumber: 3,
          data: {
            account_code: '110000',
            account_name: 'Aset Lancar',
            account_type: 'invalid',
            normal_balance: 'debit',
          },
        },
      ],
      emptyCatalog,
    )
    expect(
      invalidParent.rows[0]?.issues.some((issue) => issue.code === 'invalid_parent_account'),
    ).toBe(true)

    const cyclic = await validation.validate(
      1,
      'chart_of_accounts',
      [
        {
          rowNumber: 2,
          data: {
            account_code: 'A',
            account_name: 'Akun A',
            account_type: 'asset',
            normal_balance: 'debit',
            parent_code: 'B',
          },
        },
        {
          rowNumber: 3,
          data: {
            account_code: 'B',
            account_name: 'Akun B',
            account_type: 'asset',
            normal_balance: 'debit',
            parent_code: 'A',
          },
        },
      ],
      emptyCatalog,
    )
    expect(
      cyclic.rows.every((row) =>
        row.issues.some((issue) => issue.code === 'account_hierarchy_cycle'),
      ),
    ).toBe(true)
  })
})
