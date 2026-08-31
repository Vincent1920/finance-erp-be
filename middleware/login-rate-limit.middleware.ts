import { createMiddleware } from 'hono/factory'
import { AppError } from '../utils/AppError'

interface AttemptWindow {
  count: number
  resetAt: number
}

const attempts = new Map<string, AttemptWindow>()
const WINDOW_MS = 15 * 60 * 1000
const MAX_ATTEMPTS = 10

export const loginRateLimit = createMiddleware(async (c, next) => {
  const now = Date.now()
  const key =
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-real-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  const current = attempts.get(key)
  const window = !current || current.resetAt <= now ? { count: 0, resetAt: now + WINDOW_MS } : current

  if (window.count >= MAX_ATTEMPTS) {
    c.header('Retry-After', String(Math.ceil((window.resetAt - now) / 1000)))
    throw new AppError('Terlalu banyak percobaan login. Coba lagi beberapa saat.', 429)
  }

  window.count += 1
  attempts.set(key, window)
  c.header('X-RateLimit-Limit', String(MAX_ATTEMPTS))
  c.header('X-RateLimit-Remaining', String(Math.max(0, MAX_ATTEMPTS - window.count)))
  await next()

  if (c.res.status < 400) attempts.delete(key)
})
