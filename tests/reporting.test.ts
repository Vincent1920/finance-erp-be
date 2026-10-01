import { describe, expect, test } from 'bun:test'
import { ReportingService, fiscalYearStartDate } from '../services/ReportingService'

describe('financial report presentation contract', () => {
  test('profit and loss keeps natural account signs and calculates subtotals consistently', async () => {
    const repository = {
      accountMovements: async () => [
        {
          id: 1,
          code: '4101',
          name: 'Penjualan',
          account_type: 'revenue',
          debit: 21_000_000,
          credit: 0,
        },
        { id: 2, code: '5101', name: 'HPP', account_type: 'cogs', debit: 0, credit: 17_000_000 },
        {
          id: 3,
          code: '6101',
          name: 'Beban Gaji',
          account_type: 'expense',
          debit: 1_100_000,
          credit: 0,
        },
      ],
    }
    const report = await new ReportingService(repository as any).profitLoss(1, {
      dateFrom: '2026-09-01',
      dateTo: '2026-09-30',
    })
    expect(report.sections.revenue.total).toBe('-21000000.00')
    expect(report.sections.cogs.total).toBe('-17000000.00')
    expect(report.grossProfit).toBe('-4000000.00')
    expect(report.operatingProfit).toBe('-5100000.00')
  })

  test('uses the configured fiscal month to determine the active reporting period', () => {
    expect(fiscalYearStartDate('2026-10-01', 4)).toBe('2026-04-01')
    expect(fiscalYearStartDate('2026-03-31', 4)).toBe('2025-04-01')
    expect(fiscalYearStartDate('2026-10-01', 99)).toBe('2025-12-01')
  })

  test('classifies income tax from report group and reports legacy name fallback', async () => {
    const repository = {
      accountMovements: async () => [
        {
          id: 1,
          code: '6101',
          name: 'Beban Pajak Kendaraan',
          account_type: 'expense',
          report_group: 'operating_expense',
          debit: 100,
          credit: 0,
        },
        {
          id: 2,
          code: '6201',
          name: 'Beban Kini',
          account_type: 'expense',
          report_group: 'income_tax_expense',
          debit: 200,
          credit: 0,
        },
        {
          id: 3,
          code: '6202',
          name: 'Beban Pajak Penghasilan Lama',
          account_type: 'expense',
          report_group: null,
          debit: 300,
          credit: 0,
        },
      ],
    }
    const report = await new ReportingService(repository as any).profitLoss(1, {
      dateFrom: '2026-01-01',
      dateTo: '2026-12-31',
    })

    expect(report.sections.operatingExpenses.total).toBe('100.00')
    expect(report.sections.tax.total).toBe('500.00')
    expect(report.classificationWarnings).toHaveLength(1)
    expect(report.classificationWarnings[0]?.code).toBe('6202')
  })

  test('separates current fiscal earnings from prior unclosed earnings without unbalancing the report', async () => {
    let requestedRange: { dateFrom: string; dateTo: string } | undefined
    const repository = {
      companyReportingSettings: async () => ({ fiscal_year_start: 4, base_currency: 'IDR' }),
      accountBalancesAsOf: async () => [
        { id: 1, code: '1101', name: 'Kas', account_type: 'asset', debit: 180, credit: 0 },
        { id: 2, code: '2101', name: 'Utang', account_type: 'liability', debit: 0, credit: 50 },
        { id: 3, code: '3101', name: 'Modal', account_type: 'equity', debit: 0, credit: 70 },
        { id: 4, code: '4101', name: 'Pendapatan', account_type: 'revenue', debit: 0, credit: 100 },
        { id: 5, code: '6101', name: 'Beban', account_type: 'expense', debit: 40, credit: 0 },
      ],
      accountMovements: async (_companyId: number, range: { dateFrom: string; dateTo: string }) => {
        requestedRange = range
        return [
          {
            id: 4,
            code: '4101',
            name: 'Pendapatan',
            account_type: 'revenue',
            debit: 0,
            credit: 30,
          },
          { id: 5, code: '6101', name: 'Beban', account_type: 'expense', debit: 10, credit: 0 },
        ]
      },
    }
    const report = await new ReportingService(repository as any).balanceSheet(1, '2026-10-01')

    expect(requestedRange).toEqual({ dateFrom: '2026-04-01', dateTo: '2026-10-01' })
    expect(report.sections.equity.currentYearEarnings).toBe('20.00')
    expect(report.sections.equity.unclosedPriorEarnings).toBe('40.00')
    expect(report.equity).toBe('130.00')
    expect(report.balanced).toBe(true)
  })
})
