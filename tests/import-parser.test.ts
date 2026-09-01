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
    content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength,
    ) as ArrayBuffer,
})

const referenceExecutor = (existingSalesInvoice = false) =>
  ({
    execute: async (sql: string) => {
      if (sql.includes('FROM accounts')) {
        return [
          [
            {
              id: 1,
              code: '110100',
              name: 'Kas',
              is_posting: true,
              allow_manual_journal: true,
            },
            {
              id: 2,
              code: '410100',
              name: 'Penjualan',
              is_posting: true,
              allow_manual_journal: true,
            },
          ],
        ]
      }
      if (sql.includes('FROM customers')) {
        return [[{ id: 1, code: 'CUST-001', currency: 'IDR', receivable_account_id: 1 }]]
      }
      if (sql.includes('FROM suppliers')) {
        return [[{ id: 1, code: 'SUP-001', currency: 'IDR', payable_account_id: 1 }]]
      }
      if (sql.includes('FROM items')) {
        return [
          [
            {
              id: 1,
              sku: 'ITEM-001',
              item_type: 'inventory',
              unit_id: 1,
              sales_account_id: 2,
              inventory_account_id: 1,
              purchase_account_id: 2,
            },
          ],
        ]
      }
      if (sql.includes('FROM units')) return [[{ id: 1, code: 'PCS' }]]
      if (sql.includes('FROM warehouses')) return [[{ id: 1, code: 'WH-01' }]]
      if (sql.includes('FROM accounting_periods')) {
        return [[{ id: 1, start_date: '2026-01-01', end_date: '2026-12-31' }]]
      }
      if (sql.includes('FROM sales_invoices')) {
        return [existingSalesInvoice ? [{ reference: 'INV-EXISTING', party: 'CUST-001' }] : []]
      }
      return [[]]
    },
  }) as unknown as QueryExecutor

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

  test('rejects malformed XLSX content', async () => {
    const malformed = Buffer.from('this is not an xlsx workbook')
    await expect(
      parseImportFile(
        file(
          'broken.xlsx',
          malformed,
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ),
        'sales',
      ),
    ).rejects.toThrow('Signature file XLSX tidak valid')
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

  test('reports invalid sales and purchase references with their fields and values', async () => {
    const validation = new ImportValidationService()
    const base = {
      transaction_date: '2026-08-01',
      invoice_number: 'INV-001',
      item_code: 'ITEM-MISSING',
      quantity: 1,
      unit_price: 100,
      discount: 0,
      tax_code: '',
      warehouse: 'WH-01',
      due_date: '2026-08-31',
      description: 'Negative test',
    }

    const sales = await validation.validate(
      1,
      'sales',
      [{ rowNumber: 25, data: { ...base, customer_code: 'CUST-MISSING' } }],
      referenceExecutor(),
    )
    expect(sales.rows[0]).toMatchObject({ rowNumber: 25, status: 'error' })
    expect(sales.rows[0]?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'customer_code',
          value: 'CUST-MISSING',
          code: 'reference_not_found',
        }),
        expect.objectContaining({
          field: 'item_code',
          value: 'ITEM-MISSING',
          code: 'reference_not_found',
        }),
      ]),
    )

    const purchase = await validation.validate(
      1,
      'purchase',
      [{ rowNumber: 8, data: { ...base, supplier_code: 'SUP-MISSING' } }],
      referenceExecutor(),
    )
    expect(purchase.rows[0]?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'supplier_code',
          value: 'SUP-MISSING',
          code: 'reference_not_found',
        }),
      ]),
    )
  })

  test('rejects invalid quantity and an unbalanced journal with an invalid account', async () => {
    const validation = new ImportValidationService()
    const invalidQuantity = await validation.validate(
      1,
      'sales',
      [
        {
          rowNumber: 2,
          data: {
            transaction_date: '2026-08-01',
            invoice_number: 'INV-QTY',
            customer_code: 'CUST-001',
            item_code: 'ITEM-001',
            quantity: 0,
            unit_price: 100,
            discount: 0,
            tax_code: '',
            warehouse: 'WH-01',
            due_date: '2026-08-31',
            description: 'Invalid quantity',
          },
        },
      ],
      referenceExecutor(),
    )
    expect(invalidQuantity.rows[0]?.issues.some((issue) => issue.field === 'quantity')).toBe(true)

    const journal = await validation.validate(
      1,
      'journal',
      [
        {
          rowNumber: 2,
          data: {
            journal_date: '2026-08-01',
            reference: 'JV-INVALID',
            description: 'Debit',
            account_code: 'ACCOUNT-MISSING',
            debit: 100,
            credit: 0,
            cost_center: '',
            project: '',
          },
        },
        {
          rowNumber: 3,
          data: {
            journal_date: '2026-08-01',
            reference: 'JV-INVALID',
            description: 'Credit',
            account_code: '410100',
            debit: 0,
            credit: 90,
            cost_center: '',
            project: '',
          },
        },
      ],
      referenceExecutor(),
    )
    expect(
      journal.rows.every((row) => row.issues.some((issue) => issue.code === 'unbalanced_document')),
    ).toBe(true)
    expect(
      journal.rows[0]?.issues.some(
        (issue) => issue.field === 'account_code' && issue.code === 'reference_not_found',
      ),
    ).toBe(true)
  })

  test('marks an existing invoice as duplicate without overwriting it', async () => {
    const validation = new ImportValidationService()
    const result = await validation.validate(
      1,
      'sales',
      [
        {
          rowNumber: 2,
          data: {
            transaction_date: '2026-08-01',
            invoice_number: 'INV-EXISTING',
            customer_code: 'CUST-001',
            item_code: 'ITEM-001',
            quantity: 1,
            unit_price: 100,
            discount: 0,
            tax_code: '',
            warehouse: 'WH-01',
            due_date: '2026-08-31',
            description: 'Duplicate invoice',
          },
        },
      ],
      referenceExecutor(true),
    )
    expect(result.rows[0]).toMatchObject({ isDuplicate: true, status: 'warning' })
    expect(result.rows[0]?.issues.some((issue) => issue.code === 'duplicate_existing')).toBe(true)
  })
})
