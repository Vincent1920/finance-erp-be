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
