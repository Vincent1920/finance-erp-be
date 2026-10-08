import { describe, expect, test } from 'bun:test'
import { accountSchema } from '../validators/entity.validator'

describe('COA input contract', () => {
  test('level is server-managed and ignored from client payload', () => {
    const account = accountSchema.parse({
      code: '1101',
      name: 'Kas',
      account_type: 'asset',
      normal_balance: 'debit',
      level: 9,
      is_header: false,
      is_posting: true,
    })

    expect('level' in account).toBe(false)
  })

  test('account type and normal balance use controlled values', () => {
    expect(() =>
      accountSchema.parse({
        code: '9999',
        name: 'Akun tidak valid',
        account_type: 'memo',
        normal_balance: 'netral',
      }),
    ).toThrow()
  })
})
