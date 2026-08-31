import type { QueryExecutor } from '../types/database'

import { InventoryRepository } from '../repositories/InventoryRepository'
import { ConflictError, NotFoundError, ValidationError } from '../utils/AppError'
import {
  addDecimal,
  compareDecimal,
  divideDecimal,
  multiplyDecimal,
  normalizeDecimal,
  subtractDecimal,
  type DecimalInput,
} from '../utils/decimal'
import { BusinessValidationService } from './BusinessValidationService'

export interface InventoryMovementInput {
  companyId: number
  itemId: number
  warehouseId: number
  direction: 'in' | 'out'
  quantity: DecimalInput
  unitCost?: DecimalInput
  transactionType: string
  transactionId: number
  sourceLineId?: number | null
  transactionNumber: string
  movementDate: string
  reference?: string | null
  journalId?: number | null
  postingKey: string
  userId: number
  isReversal?: boolean
  reversalMovementId?: number | null
}

export class InventoryCostingService {
  constructor(
    private repository = new InventoryRepository(),
    private validation = new BusinessValidationService(),
  ) {}

  async applyMovement(connection: QueryExecutor, input: InventoryMovementInput) {
    if (await this.repository.movementByPostingKey(connection, input.companyId, input.postingKey)) {
      throw new ConflictError('Pergerakan stok untuk baris transaksi ini sudah pernah dibuat')
    }
    await this.validation.ensureActiveReference(connection, {
      table: 'warehouses',
      id: input.warehouseId,
      companyId: input.companyId,
      label: 'Gudang',
    })
    const item = await this.repository.item(connection, input.companyId, input.itemId)
    if (!item) throw new NotFoundError('Barang tidak ditemukan atau tidak aktif')
    if (item.item_type !== 'inventory') {
      throw new ValidationError('Hanya barang bertipe inventory yang dapat mengubah stok')
    }

    const quantity = normalizeDecimal(input.quantity, 4)
    if (compareDecimal(quantity, '0', 4) <= 0) {
      throw new ValidationError('Kuantitas pergerakan stok harus lebih dari nol')
    }
    const balance = await this.repository.lockBalance(
      connection,
      input.companyId,
      input.itemId,
      input.warehouseId,
    )
    if (!balance) throw new ConflictError('Saldo persediaan tidak dapat dikunci')

    const oldQuantity = normalizeDecimal(balance.quantity, 4)
    const oldAverageCost = normalizeDecimal(balance.average_cost, 6)
    const oldValue = normalizeDecimal(balance.total_value)
    let newQuantity: string
    let newAverageCost: string
    let newValue: string
    let unitCost: string
    let movementValue: string

    if (input.direction === 'in') {
      unitCost = normalizeDecimal(input.unitCost ?? '0', 6)
      if (compareDecimal(unitCost, '0', 6) < 0) {
        throw new ValidationError('Biaya masuk persediaan tidak boleh negatif')
      }
      movementValue = multiplyDecimal(quantity, 4, unitCost, 6, 2)
      newQuantity = addDecimal([oldQuantity, quantity], 4)
      newValue = addDecimal([oldValue, movementValue])
      newAverageCost =
        compareDecimal(newQuantity, '0', 4) === 0
          ? '0.000000'
          : divideDecimal(newValue, 2, newQuantity, 4, 6)
    } else {
      newQuantity = subtractDecimal(oldQuantity, quantity, 4)
      if (
        compareDecimal(newQuantity, '0', 4) < 0 &&
        !(await this.repository.negativeStockAllowed(connection, input.companyId))
      ) {
        throw new ConflictError(
          `Stok ${String(item.sku)} di gudang tidak mencukupi (tersedia ${oldQuantity})`,
        )
      }
      unitCost = oldAverageCost
      movementValue = multiplyDecimal(quantity, 4, unitCost, 6, 2)
      newAverageCost = compareDecimal(newQuantity, '0', 4) === 0 ? '0.000000' : oldAverageCost
      newValue =
        compareDecimal(newQuantity, '0', 4) === 0
          ? '0.00'
          : compareDecimal(newQuantity, '0', 4) < 0
            ? multiplyDecimal(newQuantity, 4, unitCost, 6, 2)
            : subtractDecimal(oldValue, movementValue)
    }

    await this.repository.updateBalance(
      connection,
      Number(balance.id),
      newQuantity,
      newAverageCost,
      newValue,
    )
    const movementId = await this.repository.insertMovement(connection, {
      companyId: input.companyId,
      itemId: input.itemId,
      warehouseId: input.warehouseId,
      transactionType: input.transactionType,
      transactionId: input.transactionId,
      sourceLineId: input.sourceLineId,
      transactionNumber: input.transactionNumber,
      movementDate: input.movementDate,
      quantityIn: input.direction === 'in' ? quantity : '0.0000',
      quantityOut: input.direction === 'out' ? quantity : '0.0000',
      unitCost,
      totalCost: movementValue,
      runningQuantity: newQuantity,
      runningValue: newValue,
      reference: input.reference,
      journalId: input.journalId,
      postingKey: input.postingKey,
      userId: input.userId,
      isReversal: input.isReversal,
      reversalMovementId: input.reversalMovementId,
    })
    await this.repository.refreshItemAverageCost(connection, input.companyId, input.itemId)
    return { movementId, unitCost, totalCost: movementValue, quantity: newQuantity, value: newValue }
  }

  async reverseMovement(
    connection: QueryExecutor,
    input: {
      companyId: number
      movementId: number
      movementDate: string
      transactionType: string
      transactionId: number
      transactionNumber: string
      userId: number
      reference?: string | null
    },
  ) {
    const original = await this.repository.movement(connection, input.companyId, input.movementId)
    if (!original) throw new NotFoundError('Pergerakan stok asal tidak ditemukan')
    if (original.reversal_movement_id) throw new ConflictError('Pergerakan stok sudah direversal')
    const originalIn = compareDecimal(String(original.quantity_in), '0', 4) > 0
    const result = await this.applyMovement(connection, {
      companyId: input.companyId,
      itemId: Number(original.item_id),
      warehouseId: Number(original.warehouse_id),
      direction: originalIn ? 'out' : 'in',
      quantity: originalIn ? String(original.quantity_in) : String(original.quantity_out),
      unitCost: String(original.unit_cost),
      transactionType: input.transactionType,
      transactionId: input.transactionId,
      sourceLineId: Number(original.source_line_id ?? original.id),
      transactionNumber: input.transactionNumber,
      movementDate: input.movementDate,
      reference: input.reference,
      postingKey: `reversal:${original.id}`,
      userId: input.userId,
      isReversal: true,
      reversalMovementId: Number(original.id),
    })
    await connection.execute(
      'UPDATE inventory_movements SET reversal_movement_id = ? WHERE id = ?',
      [result.movementId, original.id],
    )
    return result
  }
}
