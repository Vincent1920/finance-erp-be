import { createMiddleware } from 'hono/factory'
import { UnauthorizedError } from '../utils/AppError'
import { verifyToken } from '../utils/token'
export const authMiddleware = createMiddleware(async (c, next) => {
  const header = c.req.header('Authorization')
  if (!header?.startsWith('Bearer ')) throw new UnauthorizedError()
  try {
    c.set('user', verifyToken(header.slice(7)))
    await next()
  } catch {
    throw new UnauthorizedError('Token tidak valid atau kedaluwarsa')
  }
})
