import { describe, expect, test } from 'bun:test'
import { customerSchema, supplierSchema } from '../validators/entity.validator'
import { quantitySchema, nonnegativeQuantitySchema } from '../validators/common.validator'
import { depreciationTarget } from '../services/FixedAssetService'
import {
  bankMatchBatchSchema,
  printTemplateSchema,
  purchaseReturnSchema,
} from '../validators/operations.validator'
import { companyProfileSchema } from '../validators/system.validator'
import {
  payrollEmployeeStatusSchema,
  payrollEntryUpdateSchema,
  payrollPolicySchema,
} from '../validators/payroll.validator'
import { calculateBpjs } from '../services/PayrollService'
import {
  periodCloseValidationSchema,
  periodReopenSchema,
} from '../validators/period-closing.validator'
import { validateBackupDocument } from '../services/BackupService'
import { fiscalYearRange } from '../services/YearEndClosingService'
import { yearEndPreviewSchema, yearEndReverseSchema } from '../validators/year-end.validator'
import { nextRecurringDate } from '../services/RecurringJournalService'
import {
  recurringActiveSchema,
  recurringJournalSchema,
} from '../validators/recurring-journal.validator'
import {
  reconciliationCaseSchema,
  reconciliationDetailQuerySchema,
} from '../validators/report.validator'
import { settingCapability } from '../services/SettingCapabilityService'

describe('Operational input safeguards', () => {
  test('settings distinguish enforced, reference, and planned behavior', () => {
    expect(settingCapability('sales.block_over_credit_limit')).toMatchObject({
      capability: 'enforced',
      editable: true,
    })
    expect(settingCapability('default_bank_account_id')).toMatchObject({
      capability: 'reference',
      editable: true,
    })
    expect(settingCapability('inventory.cost_method')).toMatchObject({
      capability: 'enforced',
      editable: true,
    })
    expect(settingCapability('inventory.reorder_notifications')).toMatchObject({
      capability: 'planned',
      editable: false,
    })
  })
  test('reconciliation workflow requires evidence when a difference is closed', () => {
    const base = {
      as_of_date: '2026-09-30',
      reconciliation_type: 'ar',
      account_id: 1,
      general_ledger: 100,
      subledger: 90,
      difference: -10,
    }
    expect(
      reconciliationCaseSchema.safeParse({ ...base, status: 'in_review', assigned_to: 2 }).success,
    ).toBeTrue()
    expect(reconciliationCaseSchema.safeParse({ ...base, status: 'resolved' }).success).toBeFalse()
    expect(
      reconciliationCaseSchema.safeParse({
        ...base,
        status: 'resolved',
        note: 'Jurnal koreksi JV-2026-09-000001 sudah diposting.',
      }).success,
    ).toBeTrue()
    expect(
      reconciliationCaseSchema.safeParse({
        ...base,
        status: 'accepted_variance',
        note: 'Selisih pembulatan tidak material.',
      }).success,
    ).toBeTrue()
    expect(
      reconciliationDetailQuerySchema.safeParse({ ...base, reconciliation_type: 'unsupported' })
        .success,
    ).toBeFalse()
  })
  test('bank reconciliation accepts partial many-to-many allocations', () => {
    const request_key = crypto.randomUUID()
    expect(
      bankMatchBatchSchema.safeParse({
        request_key,
        allocations: [
          { statement_line_id: 1, journal_line_id: 10, matched_amount: 75000 },
          { statement_line_id: 1, journal_line_id: 11, matched_amount: 25000 },
          { statement_line_id: 2, journal_line_id: 11, matched_amount: 50000 },
        ],
      }).success,
    ).toBeTrue()
    expect(
      bankMatchBatchSchema.safeParse({
        request_key,
        allocations: [{ statement_line_id: 1, journal_line_id: 10, matched_amount: 0 }],
      }).success,
    ).toBeFalse()
  })
  test('employee deactivation requires an effective date and auditable reason', () => {
    expect(
      payrollEmployeeStatusSchema.safeParse({ is_active: false, reason: 'Kontrak selesai' })
        .success,
    ).toBeFalse()
    expect(
      payrollEmployeeStatusSchema.safeParse({
        is_active: false,
        effective_date: '2026-10-02',
        reason: 'Kontrak selesai',
      }).success,
    ).toBeTrue()
    expect(
      payrollEmployeeStatusSchema.safeParse({ is_active: true, reason: 'Dipekerjakan kembali' })
        .success,
    ).toBeTrue()
  })
  for (const [name, schema] of [
    ['customer', customerSchema],
    ['supplier', supplierSchema],
  ] as const) {
    test(`${name} preserves leading zero and requires exactly 16 NPWP digits`, () => {
      const input = { code: 'TEST', name: 'Test entity', tax_number: '0123456789012345' }
      expect(schema.parse(input).tax_number).toBe(input.tax_number)
      for (const tax_number of [
        undefined,
        null,
        '',
        '123456789012345',
        '12345678901234567',
        '012345678901234A',
      ])
        expect(schema.safeParse({ ...input, tax_number }).success).toBeFalse()
    })
  }
  test('quantity accepts one decimal and database zero padding without silently rounding', () => {
    for (const value of ['1', '1.2', '1.2000', 0.1])
      expect(quantitySchema.safeParse(value).success).toBeTrue()
    for (const value of ['1.21', '1.2001', 0.01, -1, '0'])
      expect(quantitySchema.safeParse(value).success).toBeFalse()
    expect(nonnegativeQuantitySchema.parse(0)).toBe('0.0000')
  })
  test('company identity requires 16 digit NPWP and accepts an embedded image logo', () => {
    expect(
      companyProfileSchema.safeParse({
        name: 'PT Contoh',
        tax_number: '0123456789012345',
        logo: 'data:image/png;base64,AA==',
      }).success,
    ).toBeTrue()
    expect(
      companyProfileSchema.safeParse({
        name: 'PT Contoh',
        tax_number: '123',
        logo: 'javascript:alert(1)',
      }).success,
    ).toBeFalse()
  })
  test('print template accepts layouts, ordered columns, labels, and payment QR', () => {
    const base = {
      documentType: 'sales_invoice',
      templateStyle: 'compact',
      fontSize: 10,
      pageSize: 'A4',
      orientation: 'portrait',
      marginMm: 12,
      showCompany: true,
      showReference: true,
      showNotes: true,
      showTax: true,
      showSignature: true,
      showPaymentInfo: true,
      showPageNumber: true,
      headerTitle: 'Faktur',
      accentColor: '#2563eb',
      paymentInfo: 'BCA 123',
      paymentTerms: 'Jatuh tempo 30 hari',
      paymentQr: 'data:image/png;base64,AA==',
      partnerLabel: 'Pelanggan',
      totalLabel: 'Jumlah Dibayar',
      signatureLabels: ['Dibuat', 'Disetujui', 'Diterima'],
      columns: ['name', 'quantity', 'unit', 'price', 'subtotal'],
      watermark: '',
      footer: 'Terima kasih',
    }
    expect(printTemplateSchema.safeParse(base).success).toBeTrue()
    expect(
      printTemplateSchema.safeParse({ ...base, columns: ['code', 'subtotal'] }).success,
    ).toBeFalse()
    expect(
      printTemplateSchema.safeParse({ ...base, columns: ['name', 'name'] }).success,
    ).toBeFalse()
  })
  test('payroll manual tax correction requires a reason', () => {
    expect(payrollEntryUpdateSchema.safeParse({ pph21_override: 150000 }).success).toBeFalse()
    expect(
      payrollEntryUpdateSchema.safeParse({
        pph21_override: 150000,
        pph21_override_reason: 'Koreksi sesuai hasil pemeriksaan pajak',
      }).success,
    ).toBeTrue()
  })
  test('payroll policy requires an auditable source and accepts a health wage floor', () => {
    const policy = {
      effective_from: '2026-01-01',
      health_employee_rate: 0.01,
      health_employer_rate: 0.04,
      health_wage_floor: 5000000,
      health_wage_cap: 12000000,
      jht_employee_rate: 0.02,
      jht_employer_rate: 0.037,
      jp_employee_rate: 0.01,
      jp_employer_rate: 0.02,
      jp_wage_cap: 10547000,
      jkk_employer_rate: 0.0024,
      jkm_employer_rate: 0.003,
      salary_expense_account_id: 1,
      employer_bpjs_expense_account_id: 2,
      payroll_payable_account_id: 3,
      bpjs_payable_account_id: 4,
      pph21_payable_account_id: 5,
      employee_loan_account_id: 6,
      other_deduction_account_id: 7,
    }
    expect(payrollPolicySchema.safeParse(policy).success).toBeFalse()
    expect(
      payrollPolicySchema.safeParse({
        ...policy,
        source_reference: 'Surat BPJS dan peraturan perusahaan 2026',
      }).success,
    ).toBeTrue()
    expect(
      payrollPolicySchema.safeParse({
        ...policy,
        source_reference: 'Peraturan 2026',
        health_wage_floor: 13000000,
      }).success,
    ).toBeFalse()
    expect(
      payrollPolicySchema.safeParse({
        ...policy,
        source_reference: 'Peraturan 2026',
        bpjs_payable_account_id: 3,
      }).success,
    ).toBeFalse()
  })
  test('BPJS calculation applies the configured floor, caps, and percentages', () => {
    const result = calculateBpjs(4_000_000, {
      health_wage_floor: 5_000_000,
      health_wage_cap: 12_000_000,
      jp_wage_cap: 10_000_000,
      health_employee_rate: 0.01,
      health_employer_rate: 0.04,
      jht_employee_rate: 0.02,
      jht_employer_rate: 0.037,
      jp_employee_rate: 0.01,
      jp_employer_rate: 0.02,
      jkk_employer_rate: 0.0024,
      jkm_employer_rate: 0.003,
    })
    expect(result.healthEmployee).toBe(50_000)
    expect(result.healthEmployer).toBe(200_000)
    expect(result.jhtEmployee).toBe(80_000)
    expect(result.jhtEmployer).toBe(148_000)
    expect(result.jpEmployee).toBe(40_000)
  })
  test('period closing requires an explicit target and auditable reopen reason', () => {
    expect(
      periodCloseValidationSchema.safeParse({ period_id: 1, requested_status: 'closed' }).success,
    ).toBeTrue()
    expect(
      periodCloseValidationSchema.safeParse({ period_id: 1, requested_status: 'open' }).success,
    ).toBeFalse()
    expect(periodReopenSchema.safeParse({ reason: 'salah' }).success).toBeFalse()
    expect(
      periodReopenSchema.safeParse({ reason: 'Koreksi invoice bulan sebelumnya' }).success,
    ).toBeTrue()
  })
  test('year-end closing follows the company fiscal calendar and separate equity accounts', () => {
    expect(fiscalYearRange(2027, 4)).toEqual({
      dateFrom: '2026-04-01',
      dateTo: '2027-03-31',
    })
    expect(fiscalYearRange(2026, 1)).toEqual({
      dateFrom: '2026-01-01',
      dateTo: '2026-12-31',
    })
    expect(
      yearEndPreviewSchema.safeParse({
        fiscal_year: 2026,
        current_year_earnings_account_id: 1,
        retained_earnings_account_id: 1,
      }).success,
    ).toBeFalse()
    expect(
      yearEndPreviewSchema.safeParse({
        fiscal_year: 2026,
        current_year_earnings_account_id: 1,
        retained_earnings_account_id: 2,
      }).success,
    ).toBeTrue()
    expect(
      yearEndReverseSchema.safeParse({
        reversal_date: '2026-12-31',
        reason: 'Koreksi tutup tahun setelah pemeriksaan',
      }).success,
    ).toBeTrue()
  })
  test('recurring schedules preserve the original day and validate custom intervals', () => {
    expect(nextRecurringDate('2026-01-31', '2026-01-31', 'monthly')).toBe('2026-02-28')
    expect(nextRecurringDate('2026-02-28', '2026-01-31', 'monthly')).toBe('2026-03-31')
    expect(nextRecurringDate('2026-01-31', '2026-01-31', 'quarterly')).toBe('2026-04-30')
    expect(nextRecurringDate('2026-01-01', '2026-01-01', 'custom', 2, 'week')).toBe('2026-01-15')
    const base = {
      name: 'Sewa kantor bulanan',
      frequency: 'custom',
      interval_value: 2,
      start_date: '2026-01-01',
      currency: 'IDR',
      exchange_rate: 1,
      auto_submit: true,
      lines: [
        { accountId: 1, debit: 100, credit: 0 },
        { accountId: 2, debit: 0, credit: 100 },
      ],
    }
    expect(recurringJournalSchema.safeParse(base).success).toBeFalse()
    expect(recurringJournalSchema.safeParse({ ...base, interval_unit: 'month' }).success).toBeTrue()
    expect(recurringActiveSchema.safeParse({ active: 'false' }).success).toBeFalse()
  })
  test('restore accepts only a complete full backup from the active database', () => {
    const tables = Object.fromEntries(
      ['migrations', 'companies', 'users', 'accounts', 'journals', 'journal_lines'].map((name) => [
        name,
        { createSql: `CREATE TABLE ${name}(id INT)`, rows: [] },
      ]),
    )
    const backup = {
      format: 'finora-portable-backup-v1' as const,
      database: 'finance_erp',
      createdAt: '2026-10-01T00:00:00.000Z',
      type: 'full' as const,
      tables,
    }
    expect(validateBackupDocument(backup, 'finance_erp', true).type).toBe('full')
    expect(() =>
      validateBackupDocument({ ...backup, database: 'other' }, 'finance_erp', true),
    ).toThrow()
    expect(() => validateBackupDocument({ ...backup, type: 'data' }, 'finance_erp', true)).toThrow()
    const { journals: _journals, ...incomplete } = tables
    expect(() =>
      validateBackupDocument({ ...backup, tables: incomplete }, 'finance_erp', true),
    ).toThrow()
  })
  test('depreciation cumulative rounding finishes exactly at residual value', () => {
    expect(depreciationTarget('100.00', '0.00', 3, 1)).toBe('33.33')
    expect(depreciationTarget('100.00', '0.00', 3, 2)).toBe('66.67')
    expect(depreciationTarget('100.00', '10.00', 7, 20)).toBe('90.00')
    expect(depreciationTarget('100.00', '10.00', 7, -1)).toBe('0.00')
  })
  test('purchase return rejects duplicate source lines', () => {
    expect(
      purchaseReturnSchema.safeParse({
        request_key: crypto.randomUUID(),
        invoice_id: 1,
        date: '2026-01-01',
        reason: 'Damaged',
        lines: [
          { invoice_line_id: 1, quantity: 1 },
          { invoice_line_id: 1, quantity: 1 },
        ],
      }).success,
    ).toBeFalse()
  })
})
