import { describe, expect, test } from 'bun:test'
import { assertBalanced } from '../services/PostingService'
import {
  BusinessValidationService,
  booleanSettingEnabled,
} from '../services/BusinessValidationService'
import { journalListQuerySchema } from '../validators/journal.validator'
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

  test('self-approval requires an explicit enabled company setting', () => {
    expect(booleanSettingEnabled(undefined)).toBe(false)
    expect(booleanSettingEnabled('false')).toBe(false)
    expect(booleanSettingEnabled('0')).toBe(false)
    expect(booleanSettingEnabled('true')).toBe(true)
    expect(booleanSettingEnabled('1')).toBe(true)
  })

  test('maker-checker rejects the submitter unless company override is enabled', async () => {
    const validation = new BusinessValidationService()
    const disabledConnection = {
      execute: async () => [[{ setting_value: 'false' }], []],
    } as any
    await expect(validation.ensureIndependentApprover(disabledConnection, 1, 9, 9)).rejects.toThrow(
      'Pembuat/pengaju jurnal tidak boleh menyetujui jurnal yang sama',
    )

    const enabledConnection = {
      execute: async () => [[{ setting_value: 'true' }], []],
    } as any
    await expect(
      validation.ensureIndependentApprover(enabledConnection, 1, 9, 9),
    ).resolves.toBeUndefined()
  })

  test('journal sorting only accepts server-approved columns and directions', () => {
    expect(journalListQuerySchema.parse({ sort: 'total_debit', order: 'asc' })).toMatchObject({
      sort: 'total_debit',
      order: 'asc',
    })
    expect(() => journalListQuerySchema.parse({ sort: 'j.id DESC; DROP TABLE journals' })).toThrow()
  })
})
