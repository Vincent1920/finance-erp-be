const sensitiveKey = /password|token|secret|authorization|cookie|credential|stack/i

export function sanitizeForLog(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  if (Array.isArray(value)) return value.map((item) => sanitizeForLog(item, seen))

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      sensitiveKey.test(key) ? '[REDACTED]' : sanitizeForLog(item, seen),
    ]),
  )
}

export function toJson(value: unknown): string | null {
  if (value === undefined || value === null) return null
  try {
    return JSON.stringify(sanitizeForLog(value))
  } catch {
    return JSON.stringify('[Unserializable]')
  }
}
