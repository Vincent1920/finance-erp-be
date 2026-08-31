import { createMiddleware } from 'hono/factory'
import { UserRepository } from '../repositories/UserRepository'
import { UnauthorizedError } from '../utils/AppError'
import { verifyToken } from '../utils/token'

const users = new UserRepository()

export const authMiddleware = createMiddleware(async (c, next) => {
  const header = c.req.header('Authorization')
  if (!header?.startsWith('Bearer ')) throw new UnauthorizedError()

  let tokenUser
  try {
    tokenUser = verifyToken(header.slice(7))
  } catch {
    throw new UnauthorizedError('Token tidak valid atau kedaluwarsa')
  }

  const user = await users.freshAuthUser(tokenUser.id, tokenUser.companyId)
  if (!user) throw new UnauthorizedError('Akun tidak aktif atau akses telah dicabut')
  c.set('user', user)
  await next()
})
