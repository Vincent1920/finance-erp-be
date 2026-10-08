import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { requireRole } from '../middleware/role.middleware'
import { AppError } from '../utils/AppError'
import type { AppBindings } from '../types/hono'

const roleApp = (roles: string[]) => {
  const app = new Hono<AppBindings>()
  app.use('*', async (c, next) => {
    c.set('user', { id: 1, companyId: 1, name: 'Test Admin', email: 'admin@example.test', roles, permissions: ['*'] })
    await next()
  })
  app.get('/backup', requireRole('super-admin'), (c) => c.text('ok'))
  app.onError((error) => new Response(error.message, { status: error instanceof AppError ? error.status : 500 }))
  return app
}

describe('Role middleware', () => {
  test('backup administration rejects a non-super-admin', async () => {
    const response = await roleApp(['accountant']).request('/backup')
    expect(response.status).toBe(403)
  })

  test('backup administration accepts a super-admin', async () => {
    const response = await roleApp(['super-admin']).request('/backup')
    expect(response.status).toBe(200)
  })
})
