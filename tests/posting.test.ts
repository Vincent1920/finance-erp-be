import { describe, expect, test } from 'bun:test'
import { assertBalanced } from '../services/PostingService'
describe('accounting integrity', () => {
  test('balanced journal accepted', () =>
    expect(() =>
      assertBalanced([
        { accountId: 1, debit: 100, credit: 0 },
        { accountId: 2, debit: 0, credit: 100 },
      ]),
    ).not.toThrow())
  test('unbalanced journal rejected', () =>
    expect(() =>
      assertBalanced([
        { accountId: 1, debit: 100, credit: 0 },
        { accountId: 2, debit: 0, credit: 90 },
      ]),
    ).toThrow('Jurnal tidak balance'))
  test('zero journal rejected', () =>
    expect(() =>
      assertBalanced([
        { accountId: 1, debit: 0, credit: 0 },
        { accountId: 2, debit: 0, credit: 0 },
      ]),
    ).toThrow())
})
