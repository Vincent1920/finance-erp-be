import { describe, expect, test } from 'bun:test'
import { calculateSettlementAmounts } from '../services/SettlementService'
import { settlementSchema } from '../validators/operations.validator'

const baseInput = {
  request_key: '55555555-5555-4555-8555-555555555555',
  date: '2026-10-02',
  reference: 'SETTLEMENT-CARD',
  cash_account_id: 1102,
  bank_account_id: 1,
  payment_method: 'card' as const,
  allocations: [{ invoice_id: 10, amount: 1_000_000 }],
}

describe('settlement processing fee', () => {
  test('customer card fee closes gross receivable and deposits the net amount', () => {
    expect(calculateSettlementAmounts(true, '1000000.00', '0.00', 2, '1')).toEqual({
      feeAmount: '20000.00',
      bankAmount: '980000.00',
      baseGross: '1000000.00',
      baseFee: '20000.00',
      baseBank: '980000.00',
    })
  })

  test('supplier bank fee increases the cash paid without changing invoice allocation', () => {
    expect(calculateSettlementAmounts(false, '1000000.00', '10000.00', 0, '1')).toEqual({
      feeAmount: '10000.00',
      bankAmount: '1010000.00',
      baseGross: '1000000.00',
      baseFee: '10000.00',
      baseBank: '1010000.00',
    })
  })

  test('accepts the default BANK_FEE mapping or an explicit expense account', () => {
    expect(settlementSchema.safeParse({ ...baseInput, processing_fee_amount: 20000 }).success).toBeTrue()
    expect(settlementSchema.safeParse({ ...baseInput, processing_fee_amount: 20000, processing_fee_account_id: 6102 }).success).toBeTrue()
  })
})
