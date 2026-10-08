import { describe, expect, test } from 'bun:test'
import { ensureMonthlyPrefix, renderSequencePrefix, sequencePreview } from '../services/NumberSequenceService'
import { sequenceSchema } from '../validators/system.validator'

describe('document number format', () => {
  test('renders year, month, day, and sequence padding', () => {
    expect(sequencePreview('JV/{YYYY}/{MM}/{DD}/', 6, 16, '2026-06-05')).toBe('JV/2026/06/05/000016')
  })

  test('normalizes a legacy prefix that has no month', () => {
    expect(ensureMonthlyPrefix('JV-{YYYY}-')).toBe('JV-{YYYY}-{MM}-')
    expect(renderSequencePrefix('JV-{YYYY}-', '2026-02-05')).toBe('JV-2026-02-')
  })

  test('settings require the month token and reject unknown tokens', () => {
    expect(sequenceSchema.safeParse({ sequence_key: 'journal', prefix: 'JV-{YYYY}-', padding: 6, reset_period: 'monthly' }).success).toBeFalse()
    expect(sequenceSchema.safeParse({ sequence_key: 'journal', prefix: 'JV-{YYYY}-{MM}-{ABC}-', padding: 6, reset_period: 'monthly' }).success).toBeFalse()
    expect(sequenceSchema.safeParse({ sequence_key: 'journal', prefix: 'JV-{YYYY}-{MM}-', padding: 6, reset_period: 'monthly' }).success).toBeTrue()
  })
})
