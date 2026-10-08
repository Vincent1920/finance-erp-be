import {cookieToken,csrfCheck} from '../utils/auth-cookie'
import {env} from '../config/env'
import {assertTenantAccess} from '../services/TenantAccessService'
import { AuthSessionService } from '../services/AuthSessionService'
import { createMiddleware } from 'hono/factory'
import { UserRepository } from '../repositories/UserRepository'
import { UnauthorizedError } from '../utils/AppError'
import { verifyToken } from '../utils/token'

const users = new UserRepository()

export const authMiddleware = createMiddleware(async (c, next) => {
  const header = c.req.header('Authorization')
  const fromCookie=cookieToken(c)
  const token=fromCookie??(env.APP_ENV!=='production'&&header?.startsWith('Bearer ')?header.slice(7):null)
  if(!token)throw new UnauthorizedError()
  if(fromCookie)csrfCheck(c,token)

  let tokenUser
  try {
    tokenUser = verifyToken(token)
  } catch {
    throw new UnauthorizedError('Token tidak valid atau kedaluwarsa')
  }

  const user = await users.freshAuthUser(tokenUser.id, tokenUser.companyId)
  if (!user) throw new UnauthorizedError('Akun tidak aktif atau akses telah dicabut')
  const sessionId=await new AuthSessionService().validate(token,user.id,user.companyId)
  c.set('sessionId',sessionId)
  if(!user.isPlatformOperator && !c.req.path.endsWith('/auth/logout'))await assertTenantAccess(user.companyId)
  c.set('user', user)
  await next()
})
