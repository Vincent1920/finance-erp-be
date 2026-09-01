import { describe, expect, test } from 'bun:test'

import { EntityRepository } from '../repositories/EntityRepository'
import { BusinessValidationService } from '../services/BusinessValidationService'
import type { QueryExecutor } from '../types/database'

describe('master data list contracts', () => {
  test('applies supported Chart of Accounts filters to both list and count queries', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = []
    const connection = {
      execute: async (sql: string, values: unknown[] = []) => {
        calls.push({ sql, values })
        return sql.includes('COUNT(*)') ? [[{ total: 0 }]] : [[]]
      },
    } as unknown as QueryExecutor

    await new EntityRepository('accounts').list(
      7,
      {
        page: '1',
        limit: '20',
        account_type: 'asset',
        is_active: 'true',
        is_header: 'true',
        is_posting: 'false',
      },
      connection,
    )

    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.sql).toContain('account_type = ?')
      expect(call.sql).toContain('is_header = ?')
      expect(call.sql).toContain('is_posting = ?')
    }
    expect(calls[0]?.values).toEqual([7, '%%', true, 'asset', false, true, 20, 0])
    expect(calls[1]?.values).toEqual([7, '%%', true, 'asset', false, true])
  })

  test('requires an active header account for a parent-account reference', async () => {
    const connection = {
      execute: async (sql: string, values: unknown[]) => {
        expect(sql).toContain('is_header = TRUE')
        expect(values).toEqual([10, 7])
        return [[{ id: 10 }]]
      },
    } as unknown as QueryExecutor

    await expect(
      new BusinessValidationService().ensureActiveReference(connection, {
        table: 'accounts',
        id: 10,
        companyId: 7,
        label: 'Akun induk',
        headerOnly: true,
      }),
    ).resolves.toEqual(undefined)
  })
})
