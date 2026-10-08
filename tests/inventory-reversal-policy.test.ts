import { expect, test } from 'bun:test'
import { InventoryCostingService } from '../services/InventoryCostingService'

function fixture(quantity = '20', value = '3000', latest = '2026-01-02') {
  let saved: string[] = []
  const repository: any = {
    movementByPostingKey: async () => null,
    item: async () => ({ item_type: 'inventory', sku: 'TEST' }),
    lockBalance: async () => ({ id: 1, quantity, total_value: value, average_cost: '150' }),
    movement: async () => ({ cost_method: 'weighted_average' }),
    negativeStockAllowed: async () => false,
    updateBalance: async (_c: unknown, _id: number, ...values: string[]) => { saved = values },
    insertMovement: async () => 1,
    refreshItemAverageCost: async () => {},
  }
  const connection: any = { execute: async (sql: string) => [sql.includes('setting_value') ? [{ setting_value: 'weighted_average' }] : sql.includes('movement_date') ? [{ movement_date: latest }] : []] }
  const service = new InventoryCostingService(repository, { ensureActiveReference: async () => {} } as any)
  const input: any = { companyId: 1, itemId: 1, warehouseId: 1, direction: 'out', quantity: '10', unitCost: '100', totalCostOverride: '1000.00', movementDate: '2026-01-03', transactionType: 'reversal', transactionId: 1, transactionNumber: 'TEST', postingKey: 'TEST', userId: 1, isReversal: true, reversalMovementId: 1 }
  return { service, connection, input, saved: () => saved }
}

test('purchase reversal removes original value after moving average changed', async () => {
  const f = fixture()
  const result = await f.service.applyMovement(f.connection, f.input)
  expect(result.totalCost).toBe('1000.00')
  expect(f.saved()).toEqual(['10.0000', '200.000000', '2000.00'])
})
test('purchase reversal rejects zero quantity with residual value', async () => {
  const f = fixture('10', '1500')
  await expect(f.service.applyMovement(f.connection, f.input)).rejects.toThrow('saldo stok tidak valid')
  expect(f.saved()).toEqual([])
})
test('weighted average rejects postings earlier than latest item warehouse movement', async () => {
  const f = fixture('20', '3000', '2026-01-04')
  await expect(f.service.applyMovement(f.connection, f.input)).rejects.toThrow('Tanggal mutasi')
  expect(f.saved()).toEqual([])
})
