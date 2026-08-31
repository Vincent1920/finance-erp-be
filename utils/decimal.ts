export type DecimalInput = string | number | bigint

const POWERS_OF_TEN = new Map<number, bigint>([[0, 1n]])

function powerOfTen(scale: number) {
  if (!Number.isInteger(scale) || scale < 0 || scale > 12) {
    throw new RangeError('Decimal scale harus berupa integer antara 0 dan 12')
  }

  const cached = POWERS_OF_TEN.get(scale)
  if (cached) return cached

  const value = 10n ** BigInt(scale)
  POWERS_OF_TEN.set(scale, value)
  return value
}

function expandScientificNotation(value: string) {
  const match = value.match(/^([+-]?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/)
  if (!match) return value

  const [, sign, integer, fraction = '', exponentText] = match
  const digits = `${integer}${fraction}`
  const exponent = Number(exponentText)
  const decimalPosition = integer.length + exponent

  if (decimalPosition <= 0) {
    return `${sign}0.${'0'.repeat(-decimalPosition)}${digits}`
  }

  if (decimalPosition >= digits.length) {
    return `${sign}${digits}${'0'.repeat(decimalPosition - digits.length)}`
  }

  return `${sign}${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`
}

export function toScaledInteger(value: DecimalInput, scale = 2): bigint {
  if (typeof value === 'bigint') return value * powerOfTen(scale)
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('Nilai decimal harus finite')
  }

  const normalized = expandScientificNotation(String(value).trim())
  const match = normalized.match(/^([+-]?)(\d+)(?:\.(\d*))?$/)
  if (!match) throw new TypeError(`Nilai decimal tidak valid: ${String(value)}`)

  const [, sign, integer, rawFraction = ''] = match
  const keptFraction = rawFraction.slice(0, scale).padEnd(scale, '0')
  const discardedFraction = rawFraction.slice(scale)
  let result = BigInt(integer) * powerOfTen(scale) + BigInt(keptFraction || '0')

  if (discardedFraction[0] && discardedFraction[0] >= '5') result += 1n
  return sign === '-' ? -result : result
}

export function fromScaledInteger(value: bigint, scale = 2): string {
  const negative = value < 0n
  const absolute = negative ? -value : value
  const divisor = powerOfTen(scale)
  const integer = absolute / divisor
  const fraction = (absolute % divisor).toString().padStart(scale, '0')
  const sign = negative ? '-' : ''
  return scale === 0 ? `${sign}${integer}` : `${sign}${integer}.${fraction}`
}

export function normalizeDecimal(value: DecimalInput, scale = 2) {
  return fromScaledInteger(toScaledInteger(value, scale), scale)
}

export function addDecimal(values: DecimalInput[], scale = 2) {
  const total = values.reduce<bigint>(
    (sum, value) => sum + toScaledInteger(value, scale),
    0n,
  )
  return fromScaledInteger(total, scale)
}

export function subtractDecimal(left: DecimalInput, right: DecimalInput, scale = 2) {
  return fromScaledInteger(toScaledInteger(left, scale) - toScaledInteger(right, scale), scale)
}

export function multiplyDecimal(
  left: DecimalInput,
  leftScale: number,
  right: DecimalInput,
  rightScale: number,
  outputScale = 2,
) {
  const raw = toScaledInteger(left, leftScale) * toScaledInteger(right, rightScale)
  const rawScale = leftScale + rightScale

  if (rawScale === outputScale) return fromScaledInteger(raw, outputScale)
  if (rawScale < outputScale) {
    return fromScaledInteger(raw * powerOfTen(outputScale - rawScale), outputScale)
  }

  const divisor = powerOfTen(rawScale - outputScale)
  const absolute = raw < 0n ? -raw : raw
  const rounded = (absolute + divisor / 2n) / divisor
  return fromScaledInteger(raw < 0n ? -rounded : rounded, outputScale)
}

export function divideDecimal(
  numerator: DecimalInput,
  numeratorScale: number,
  denominator: DecimalInput,
  denominatorScale: number,
  outputScale = 2,
) {
  const numeratorInteger = toScaledInteger(numerator, numeratorScale)
  const denominatorInteger = toScaledInteger(denominator, denominatorScale)
  if (denominatorInteger === 0n) throw new RangeError('Pembagian decimal dengan nol')

  const scaledNumerator = numeratorInteger * powerOfTen(denominatorScale + outputScale)
  const scaledDenominator = denominatorInteger * powerOfTen(numeratorScale)
  const negative = (scaledNumerator < 0n) !== (scaledDenominator < 0n)
  const absoluteNumerator = scaledNumerator < 0n ? -scaledNumerator : scaledNumerator
  const absoluteDenominator = scaledDenominator < 0n ? -scaledDenominator : scaledDenominator
  const rounded = (absoluteNumerator + absoluteDenominator / 2n) / absoluteDenominator
  return fromScaledInteger(negative ? -rounded : rounded, outputScale)
}

export function percentageOf(amount: DecimalInput, rate: DecimalInput) {
  const raw = toScaledInteger(amount, 2) * toScaledInteger(rate, 4)
  // amount is scaled by 100 and rate by 10,000. Dividing their product by
  // 1,000,000 applies the percentage and leaves the result scaled as cents.
  const divisor = powerOfTen(6)
  const absolute = raw < 0n ? -raw : raw
  const rounded = (absolute + divisor / 2n) / divisor
  return fromScaledInteger(raw < 0n ? -rounded : rounded, 2)
}

export function compareDecimal(left: DecimalInput, right: DecimalInput, scale = 2) {
  const difference = toScaledInteger(left, scale) - toScaledInteger(right, scale)
  return difference === 0n ? 0 : difference > 0n ? 1 : -1
}

export function sumScaled(values: DecimalInput[], scale = 2) {
  return values.reduce<bigint>((sum, value) => sum + toScaledInteger(value, scale), 0n)
}
