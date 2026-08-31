import { describe, expect, test } from 'bun:test'

import {
  addDecimal,
  compareDecimal,
  divideDecimal,
  multiplyDecimal,
  normalizeDecimal,
  percentageOf,
  subtractDecimal,
} from '../utils/decimal'

describe('decimal-safe accounting helpers', () => {
  test('normalizes and rounds money without binary floating point accumulation', () => {
    expect(normalizeDecimal(0.1 + 0.2)).toBe('0.30')
    expect(addDecimal(['9007199254740991.01', '0.09'])).toBe('9007199254740991.10')
  })

  test('multiplies quantity and unit price with half-up rounding', () => {
    expect(multiplyDecimal('2.5000', 4, '1999.99', 2)).toBe('4999.98')
    expect(percentageOf('1000.00', '11')).toBe('110.00')
  })

  test('divides values at explicit source and output scales', () => {
    expect(divideDecimal('150.00', 2, '3.0000', 4, 6)).toBe('50.000000')
  })

  test('compares and subtracts exact decimal values', () => {
    expect(subtractDecimal('100.00', '33.33')).toBe('66.67')
    expect(compareDecimal('0.30', 0.1 + 0.2)).toBe(0)
  })
})
