import { describe, expect, test } from 'bun:test'
import { splitScheduleAmount } from '../services/AccountingScheduleService'
import { accountingScheduleSchema } from '../validators/accounting-schedule.validator'

describe('accounting schedule', () => {
  test('distributes rounding cents without changing the total', () => {
    const amounts = splitScheduleAmount('100.00', 3)
    expect(amounts).toEqual(['33.34', '33.33', '33.33'])
    expect(splitScheduleAmount('12000000.01', 12).at(-1)).toBe('1000000.00')
  })

  test('accepts accrual and prepayment configuration with bounded periods', () => {
    const parsed = accountingScheduleSchema.parse({
      schedule_type: 'prepayment',
      name: 'Sewa dibayar di muka',
      start_date: '2026-10-01',
      periods_count: 12,
      total_estimated_amount: 12000000,
      pnl_account_id: 10,
      balance_sheet_account_id: 20,
      auto_reverse: false,
      auto_submit: true,
      materiality_threshold: 100000,
    })
    expect(parsed.periods_count).toBe(12)
    expect(parsed.materiality_threshold).toBe(100000)
    expect(() =>
      accountingScheduleSchema.parse({
        schedule_type: 'accrual',
        name: 'Akrual',
        start_date: '2026-10-01',
        periods_count: 0,
        total_estimated_amount: 1,
        pnl_account_id: 1,
        balance_sheet_account_id: 2,
      }),
    ).toThrow()
  })

  test('requires a name when configuration is saved as a template', () => {
    expect(() =>
      accountingScheduleSchema.parse({
        schedule_type: 'accrual',
        name: 'Akrual bonus',
        start_date: '2026-10-01',
        periods_count: 1,
        total_estimated_amount: 1000000,
        pnl_account_id: 1,
        balance_sheet_account_id: 2,
        save_as_template: true,
      }),
    ).toThrow()
  })
})
