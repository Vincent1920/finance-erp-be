import { describe, expect, test } from 'bun:test'
import { signToken, verifyToken } from '../utils/token'

describe('authentication token', () => {
  test('contains only stable identity claims so it fits in an HTTP header', () => {
    const token = signToken({ id: 7, companyId: 3 })
    const claims = verifyToken(token) as Record<string, unknown>

    expect(token.length).toBeLessThan(1024)
    expect(claims.id).toBe(7)
    expect(claims.companyId).toBe(3)
    expect(claims.roles).toBeUndefined()
    expect(claims.permissions).toBeUndefined()
  })
})
