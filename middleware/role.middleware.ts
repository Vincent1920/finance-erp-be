import { createMiddleware } from 'hono/factory'
import { ForbiddenError } from '../utils/AppError'

export const requireRole = (role: string) =>
  createMiddleware(async (c, next) => {
    const user = c.get('user')
    if (!user.roles.includes(role))
      throw new ForbiddenError('Operasi ini hanya dapat dilakukan administrator sistem')
    await next()
  })

export const isPlatformOperator=(id:number)=> (process.env.PLATFORM_OPERATOR_USER_IDS??'').split(',').filter(value=>/^[1-9][0-9]*$/.test(value)).map(Number).includes(id)

// Provisioned by the platform operator, never through tenant role management.
export const requirePlatformOperator = createMiddleware(async (c, next) => {
  if (!isPlatformOperator(c.get('user').id)) throw new ForbiddenError('Akses platform hanya tersedia untuk owner/operator yang ditetapkan, bukan admin perusahaan')
  await next()
})
export const requireRestoreMaintenance = createMiddleware(async (_c, next) => {
  if (process.env.DATABASE_RESTORE_MAINTENANCE !== 'true') throw new ForbiddenError('Restore database dinonaktifkan. Operator platform harus mengaktifkan mode pemulihan terlebih dahulu')
  await next()
})
