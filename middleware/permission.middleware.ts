import { createMiddleware } from 'hono/factory'
import { ForbiddenError } from '../utils/AppError'
export const requirePermission = (permission: string) =>
  createMiddleware(async (c, next) => {
    const user = c.get('user')
    if (!user.permissions.includes('*') && !user.permissions.includes(permission))
      throw new ForbiddenError()
    await next()
  })
