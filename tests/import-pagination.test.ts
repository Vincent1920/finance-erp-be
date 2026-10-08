import { expect, test } from 'bun:test'
import { ImportRepository } from '../repositories/ImportRepository'
import type { QueryExecutor } from '../types/database'

test('import preview uses bounded integer pagination without bound LIMIT parameters', async () => {
  const calls: Array<{ sql: string; values: unknown }> = []
  const connection = {
    execute: async (sql: string, values: unknown) => {
      calls.push({ sql, values })
      return [sql.includes('COUNT(*)') ? [{ total: 0 }] : [], []]
    },
  } as unknown as QueryExecutor
  const result = await new ImportRepository().rows(1, { page: 2, limit: 50 }, connection)
  expect(calls[0]?.sql).toContain('LIMIT 50 OFFSET 50')
  expect(calls[0]?.values).toEqual([1])
  expect(result.page).toBe(2)
  await new ImportRepository().rows(1, { page: NaN, limit: Infinity }, connection)
  expect(calls[2]?.sql).toContain('LIMIT 50 OFFSET 0')
})
