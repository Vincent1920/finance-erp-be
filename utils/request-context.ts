import type { Context } from 'hono'
import type { SystemActor } from '../services/SystemUserService'

export const requestIp = (c: Context) =>
  c.req.header('cf-connecting-ip') ??
  c.req.header('x-real-ip') ??
  c.req.header('x-forwarded-for')?.split(',')[0]?.trim()

export const systemActor = (c: Context): SystemActor => {
  const user = c.get('user')
  return {
    id: user.id,
    companyId: user.companyId,
    roles: user.roles,
    requestId: c.get('requestId'),
    ip: requestIp(c),
  }
}
