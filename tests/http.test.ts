import { afterAll, describe, expect, test } from 'bun:test'
import { app } from '../app'
import { db } from '../config/database'
describe('HTTP smoke tests', () => {
  test('unknown endpoint uses standard 404 response', async () => {
    const response = await app.request('/api/not-found'),
      body = (await response.json()) as { success: boolean; message: string }
    expect(response.status).toBe(404)
    expect(body.success).toBeFalse()
    expect(body.message).toBe('Endpoint tidak ditemukan')
  })
  test('protected endpoint rejects missing token', async () => {
    const response = await app.request('/api/dashboard/summary')
    expect(response.status).toBe(401)
  })
  for (const endpoint of [
    '/api/accounting-periods',
    '/api/warehouses',
    '/api/units',
    '/api/tax-codes',
    '/api/cost-centers',
    '/api/projects',
    '/api/bank-accounts',
    '/api/sales/orders',
    '/api/sales/invoices',
    '/api/sales/receivables/aging?as_of_date=2026-09-01',
    '/api/sales/returns',
    '/api/purchases/orders',
    '/api/purchases/receipts',
    '/api/purchases/invoices',
    '/api/inventory/stock',
    '/api/imports/config',
    '/api/imports',
    '/api/users',
    '/api/roles',
    '/api/permissions',
    '/api/settings',
  ]) {
    test(`${endpoint} is registered and protected`, async () => {
      const response = await app.request(endpoint)
      expect(response.status).toBe(401)
    })
  }
  test('health endpoint responds even when database is unavailable', async () => {
    const response = await app.request('/api/health'),
      body = (await response.json()) as { success: boolean; service: string; database: string }
    expect(response.status).toBe(200)
    expect(body.success).toBeTrue()
    expect(body.service).toBe('finance-erp-be')
    expect(['connected', 'disconnected']).toContain(body.database)
  })
})
afterAll(async () => db.end())
