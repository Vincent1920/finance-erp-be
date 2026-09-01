import type { RowDataPacket } from 'mysql2/promise'
import { transaction } from '../config/database'
import {
  PurchaseOrderRepository,
  type PurchaseOrderLineWrite,
  type PurchaseOrderWrite,
} from '../repositories/PurchaseOrderRepository'
import { ConflictError, NotFoundError, ValidationError } from '../utils/AppError'
import { compareDecimal } from '../utils/decimal'
import type {
  PurchaseOrderInput,
  PurchaseOrderUpdateInput,
} from '../validators/purchase-order.validator'
import { AuditService } from './AuditService'
import {
  calculateInvoiceLine,
  calculateInvoiceTotals,
  type InvoiceMutationContext,
} from './InvoiceDomainSupport'
import { NumberSequenceService } from './NumberSequenceService'
export class PurchaseOrderService {
  constructor(
    private repo = new PurchaseOrderRepository(),
    private seq = new NumberSequenceService(),
    private audit = new AuditService(),
  ) {}
  list(c: number, q: Parameters<PurchaseOrderRepository['list']>[1]) {
    return this.repo.list(c, q)
  }
  async get(id: number, c: number) {
    const v = await this.repo.detail(id, c)
    if (!v) throw new NotFoundError('Purchase order tidak ditemukan')
    return v
  }
  async create(c: number, input: PurchaseOrderInput, x: InvoiceMutationContext) {
    return transaction(async (q) => {
      const n = await this.seq.next(q, c, 'purchase_order', input.order_date),
        h = await this.prepare(q, c, n, input, x.userId),
        id = await this.repo.insert(q, h)
      await this.log(q, c, x, 'create', id, n, { status: 'draft', grandTotal: h.grandTotal })
      return { id, orderNumber: n, status: 'draft' as const }
    })
  }
  async update(id: number, c: number, input: PurchaseOrderUpdateInput, x: InvoiceMutationContext) {
    return transaction(async (q) => {
      const old = await this.repo.find(q, id, c, true)
      if (!old) throw new NotFoundError('Purchase order tidak ditemukan')
      if (old.status !== 'draft')
        throw new ConflictError('Hanya purchase order Draft yang dapat diedit')
      const h = await this.prepare(q, c, String(old.order_number), input, x.userId)
      if (!(await this.repo.update(q, id, input.version, h)))
        throw new ConflictError('Purchase order telah berubah; muat ulang')
      await this.log(q, c, x, 'update', id, String(old.order_number), {
        version: input.version + 1,
      })
      return { id, version: input.version + 1 }
    })
  }
  confirm(id: number, c: number, x: InvoiceMutationContext) {
    return this.change(
      id,
      c,
      ['draft'],
      "status='confirmed',confirmed_by=?,confirmed_at=NOW()",
      [x.userId],
      'confirm',
      x,
    )
  }
  cancel(id: number, c: number, reason: string, x: InvoiceMutationContext) {
    return transaction(async (connection) => {
      const order = await this.repo.find(connection, id, c, true)
      if (!order) throw new NotFoundError('Purchase order tidak ditemukan')
      if (!['draft', 'confirmed'].includes(String(order.status))) {
        throw new ConflictError('Status purchase order tidak dapat dibatalkan')
      }
      if (await this.repo.activeReceiptCount(connection, id)) {
        throw new ConflictError(
          'Purchase order memiliki penerimaan aktif dan tidak dapat dibatalkan',
        )
      }
      await this.repo.transition(
        connection,
        id,
        c,
        ['draft', 'confirmed'],
        "status='cancelled',cancelled_by=?,cancelled_at=NOW(),cancellation_reason=?",
        [x.userId, reason],
      )
      await this.log(connection, c, x, 'cancel', id, String(order.order_number), {
        status: 'cancelled',
        reason,
      })
      return { id, status: 'cancelled' as const }
    })
  }
  private async change(
    id: number,
    c: number,
    from: string[],
    fields: string,
    values: any[],
    action: string,
    x: InvoiceMutationContext,
  ) {
    return transaction(async (q) => {
      const old = await this.repo.find(q, id, c, true)
      if (!old) throw new NotFoundError('Purchase order tidak ditemukan')
      if (!from.includes(String(old.status)))
        throw new ConflictError('Status purchase order tidak dapat diproses')
      if (!(await this.repo.transition(q, id, c, from, fields, values)))
        throw new ConflictError('Status purchase order telah berubah')
      await this.log(q, c, x, action, id, String(old.order_number), {
        status: action === 'confirm' ? 'confirmed' : 'cancelled',
      })
      return { id, status: action === 'confirm' ? 'confirmed' : 'cancelled' }
    })
  }
  private async prepare(
    q: any,
    c: number,
    n: string,
    input: PurchaseOrderInput,
    userId: number,
  ): Promise<PurchaseOrderWrite> {
    const skeleton: PurchaseOrderWrite = {
        companyId: c,
        orderNumber: n,
        orderDate: input.order_date,
        supplierId: input.supplier_id,
        warehouseId: input.warehouse_id,
        buyerId: input.buyer_id ?? null,
        paymentTermDays: input.payment_term_days,
        expectedDate: input.expected_date ?? null,
        supplierReference: input.supplier_reference ?? null,
        currency: input.currency,
        exchangeRate: input.exchange_rate,
        subtotal: '0.00',
        discount: '0.00',
        tax: '0.00',
        grandTotal: '0.00',
        baseGrandTotal: '0.00',
        notes: input.notes ?? null,
        userId,
        lines: input.lines.map((l, i) => ({
          lineNumber: i + 1,
          itemId: l.item_id,
          description: l.description ?? null,
          quantity: l.quantity,
          unitId: l.unit_id ?? 0,
          unitPrice: l.unit_price,
          discountPercent: l.discount_percent,
          discountAmount: l.discount_amount,
          taxCodeId: l.tax_code_id ?? null,
          taxRate: '0.0000',
          taxAmount: '0.00',
          subtotal: '0.00',
          baseSubtotal: '0.00',
        })),
      },
      refs = await this.repo.references(q, c, skeleton)
    if (!refs.supplier) throw new NotFoundError('Pemasok tidak ditemukan atau tidak aktif')
    if (!refs.warehouse) throw new NotFoundError('Gudang tidak ditemukan atau tidak aktif')
    if (String(refs.supplier.currency).toUpperCase() !== input.currency)
      throw new ValidationError('Mata uang purchase order harus sama dengan pemasok')
    const items = new Map(refs.items.map((v: RowDataPacket) => [Number(v.id), v])),
      taxes = new Map(refs.taxes.map((v: RowDataPacket) => [Number(v.id), v])),
      calculated = input.lines.map((l, i) => {
        const item = items.get(l.item_id)
        if (!item) throw new NotFoundError(`Item baris ${i + 1} tidak ditemukan`)
        const unitId = l.unit_id ?? Number(item.unit_id)
        if (unitId !== Number(item.unit_id))
          throw new ValidationError(`Satuan baris ${i + 1} tidak sesuai item`)
        const tax = l.tax_code_id ? taxes.get(l.tax_code_id) : null
        if (l.tax_code_id && !tax)
          throw new NotFoundError(`Kode pajak baris ${i + 1} tidak ditemukan`)
        return {
          line: l,
          unitId,
          amount: calculateInvoiceLine({
            quantity: l.quantity,
            unitPrice: l.unit_price,
            discount: l.discount_amount,
            discountPercent: l.discount_percent,
            taxRate: tax ? String(tax.rate) : '0',
            exchangeRate: input.exchange_rate,
          }),
        }
      }),
      totals = calculateInvoiceTotals(
        calculated.map((v) => v.amount),
        input.exchange_rate,
      )
    if (compareDecimal(totals.grandTotal, '0') <= 0)
      throw new ValidationError('Total purchase order harus lebih dari nol')
    return {
      ...skeleton,
      subtotal: totals.subtotal,
      discount: totals.discount,
      tax: totals.tax,
      grandTotal: totals.grandTotal,
      baseGrandTotal: totals.baseGrandTotal,
      lines: calculated.map<PurchaseOrderLineWrite>(({ line, unitId, amount }, i) => ({
        lineNumber: i + 1,
        itemId: line.item_id,
        description: line.description ?? null,
        quantity: amount.quantity,
        unitId,
        unitPrice: amount.unitPrice,
        discountPercent: amount.discountPercent,
        discountAmount: amount.discount,
        taxCodeId: line.tax_code_id ?? null,
        taxRate: amount.taxRate,
        taxAmount: amount.taxAmount,
        subtotal: amount.subtotal,
        baseSubtotal: amount.baseSubtotal,
      })),
    }
  }
  private log(
    q: any,
    c: number,
    x: InvoiceMutationContext,
    a: string,
    id: number,
    n: string,
    value: any,
  ) {
    return this.audit.log(q, {
      companyId: c,
      userId: x.userId,
      module: 'purchase-orders',
      action: a,
      recordType: 'purchase_order',
      recordId: id,
      recordNumber: n,
      newValue: value,
      requestId: x.requestId,
      ip: x.ip,
    })
  }
}
