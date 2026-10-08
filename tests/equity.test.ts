import { describe, expect, test } from 'bun:test'
import { previousDate, equityMovement } from '../services/EquityService'
import {
  equityTransactionSchema,
  holdingSchema,
  equityRangeSchema,
} from '../validators/equity.validator'
import { assertBalanced } from '../services/PostingService'
import { requiredAccountMappingKeys } from '../services/AccountMappingService'

describe('equity controls', () => {
  test('optional equity mappings do not block existing period closing', () => {
    expect(requiredAccountMappingKeys).not.toContain('DIVIDENDS_PAYABLE')
    expect(requiredAccountMappingKeys).not.toContain('PAID_IN_CAPITAL')
    expect(requiredAccountMappingKeys).toContain('AR_CONTROL')
  })
  test('opening date crosses fiscal/calendar boundaries correctly', () => {
    expect(previousDate('2026-01-01')).toBe('2025-12-31')
    expect(previousDate('2024-03-01')).toBe('2024-02-29')
  })
  test('negative equity and losses retain their signed value', () => {
    expect(equityMovement('100000.01', '-20000.99')).toEqual({
      opening: '100000.01',
      increase: '0.00',
      decrease: '120001.00',
      closing: '-20000.99',
    })
  })
  test('new deposits require a receiving account while old capital requires a journal', () => {
    const base = {
      request_key: crypto.randomUUID(),
      shareholder_id: 1,
      transaction_date: '2026-10-03',
      amount: '100000',
    }
    expect(
      equityTransactionSchema.safeParse({ ...base, transaction_type: 'contribution' }).success,
    ).toBe(false)
    expect(
      equityTransactionSchema.safeParse({ ...base, transaction_type: 'opening_detail' }).success,
    ).toBe(false)
    expect(
      equityTransactionSchema.safeParse({
        ...base,
        transaction_type: 'opening_detail',
        journal_id: 1,
      }).success,
    ).toBe(true)
    expect(
      equityTransactionSchema.safeParse({ ...base, transaction_type: 'dividend' }).success,
    ).toBe(true)
  })
  test('rejects impossible dates, negative deposits, fractional shares and backwards ranges', () => {
    expect(
      equityRangeSchema.safeParse({ date_from: '2026-02-30', date_to: '2026-03-31' }).success,
    ).toBe(false)
    expect(
      equityRangeSchema.safeParse({ date_from: '2026-10-03', date_to: '2026-10-01' }).success,
    ).toBe(false)
    expect(
      holdingSchema.safeParse({
        effective_date: '2026-10-03',
        shares: 0.5,
        nominal_value: 1000,
        reason: 'Transfer',
      }).success,
    ).toBe(false)
    expect(
      equityTransactionSchema.safeParse({
        request_key: crypto.randomUUID(),
        shareholder_id: 1,
        transaction_date: '2026-10-03',
        transaction_type: 'dividend',
        amount: '-1',
      }).success,
    ).toBe(false)
  })
  test('capital deposit and dividend journals balance to the cent', () => {
    expect(
      assertBalanced([
        { accountId: 1, debit: '100000.01', credit: '0' },
        { accountId: 2, debit: '0', credit: '100000.01' },
      ]).totalCredit,
    ).toBe('100000.01')
  })
})
