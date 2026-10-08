import { test, expect } from 'bun:test'
import { Hono } from 'hono'
import type { AppBindings } from '../types/hono'
import { requirePlatformOperator, requireRestoreMaintenance } from '../middleware/role.middleware'

test('tenant super-admin cannot obtain platform backup access through roles', async () => {
  const previous = process.env.PLATFORM_OPERATOR_USER_IDS
  process.env.PLATFORM_OPERATOR_USER_IDS = '999'
  try {
    const app = new Hono<AppBindings>()
    app.use('*', async (c, next) => { c.set('user', { id: 1, companyId: 1, roles: ['super-admin'], permissions: ['*'] } as any); await next() })
    app.onError((error: any, c) => c.json({ message: error.message }, error.status))
    app.get('/', requirePlatformOperator, c => c.json({ success: true }))
    expect((await app.request('/')).status).toBe(403)
    process.env.PLATFORM_OPERATOR_USER_IDS = '1'
    expect((await app.request('/')).status).toBe(200)
  } finally {
    if (previous === undefined) delete process.env.PLATFORM_OPERATOR_USER_IDS
    else process.env.PLATFORM_OPERATOR_USER_IDS = previous
  }
})
test('database restore is denied unless explicit recovery maintenance is enabled', async () => {
  const previous = process.env.DATABASE_RESTORE_MAINTENANCE
  delete process.env.DATABASE_RESTORE_MAINTENANCE
  try {
    const app = new Hono<AppBindings>()
    app.onError((error: any, c) => c.json({ message: error.message }, error.status))
    app.post('/', requireRestoreMaintenance, c => c.json({ success: true }))
    expect((await app.request('/', { method: 'POST' })).status).toBe(403)
    process.env.DATABASE_RESTORE_MAINTENANCE = 'true'
    expect((await app.request('/', { method: 'POST' })).status).toBe(200)
  } finally {
    if (previous === undefined) delete process.env.DATABASE_RESTORE_MAINTENANCE
    else process.env.DATABASE_RESTORE_MAINTENANCE = previous
  }
})
