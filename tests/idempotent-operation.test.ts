import { describe, expect, test } from 'bun:test'

import { operationPayloadHash, stableSerialize } from '../services/IdempotentOperation'

describe('idempotent operation payload', () => {
  test('object key order does not change the request identity', () => {
    const first = { invoice: 17, allocation: { amount: '1000.00', account: 1102 } }
    const second = { allocation: { account: 1102, amount: '1000.00' }, invoice: 17 }

    expect(stableSerialize(first)).toBe(stableSerialize(second))
    expect(operationPayloadHash(first)).toBe(operationPayloadHash(second))
  })

  test('array order and values remain significant', () => {
    expect(operationPayloadHash({ lines: [1, 2] })).not.toBe(
      operationPayloadHash({ lines: [2, 1] }),
    )
    expect(operationPayloadHash({ amount: '1000.00' })).not.toBe(
      operationPayloadHash({ amount: '1000.01' }),
    )
  })
})
