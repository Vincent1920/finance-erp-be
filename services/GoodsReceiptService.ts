import { transaction } from '../config/database'
import { GoodsReceiptRepository } from '../repositories/GoodsReceiptRepository'
import { ConflictError, NotFoundError, ValidationError } from '../utils/AppError'
import {
  addDecimal,
  compareDecimal,
  divideDecimal,
  multiplyDecimal,
  subtractDecimal,
} from '../utils/decimal'
import type { GoodsReceiptInput } from '../validators/goods-receipt.validator'
import { AuditService } from './AuditService'
import { InventoryCostingService } from './InventoryCostingService'
import type { InvoiceMutationContext } from './InvoiceDomainSupport'
import { NumberSequenceService } from './NumberSequenceService'
import { PostingService, type JournalLineInput } from './PostingService'
export class GoodsReceiptService {
  constructor(
    private repo = new GoodsReceiptRepository(),
    private seq = new NumberSequenceService(),
    private inventory = new InventoryCostingService(),
    private posting = new PostingService(),
    private audit = new AuditService(),
  ) {}
  list(c: number, q: Parameters<GoodsReceiptRepository['list']>[1]) {
    return this.repo.list(c, q)
  }
  async get(id: number, c: number) {
    const v = await this.repo.detail(id, c)
    if (!v) throw new NotFoundError('Penerimaan barang tidak ditemukan')
    return v
  }
  async create(c: number, input: GoodsReceiptInput, x: InvoiceMutationContext) {
    return transaction(async (q) => {
      const order = await this.repo.order(q, input.purchase_order_id, c)
      if (!order) throw new NotFoundError('Purchase order aktif tidak ditemukan')
      if (input.receipt_date < String(order.order_date).slice(0, 10))
        throw new ValidationError('Tanggal penerimaan tidak boleh sebelum purchase order')
      const source = await this.repo.orderLines(q, input.purchase_order_id),
        byId = new Map(source.map((v) => [Number(v.id), v]))
      if (new Set(input.lines.map((v) => v.purchase_order_line_id)).size !== input.lines.length)
        throw new ValidationError('Baris purchase order duplikat')
      const lines = input.lines.map((v, i) => {
          const l = byId.get(v.purchase_order_line_id)
          if (!l) throw new NotFoundError(`Baris PO ${i + 1} tidak ditemukan`)
          const available = subtractDecimal(
            subtractDecimal(String(l.quantity), String(l.received_quantity), 4),
            String(l.reserved_quantity),
            4,
          )
          if (compareDecimal(v.quantity, available, 4) > 0)
            throw new ValidationError(
              `Kuantitas penerimaan baris ${i + 1} melebihi sisa ${available}`,
            )
          const unitCost = divideDecimal(String(l.base_subtotal), 2, String(l.quantity), 4, 6)
          return {
            orderLineId: Number(l.id),
            itemId: Number(l.item_id),
            description: l.description,
            quantity: v.quantity,
            unitId: Number(l.unit_id),
            unitCost,
          }
        }),
        number = await this.seq.next(q, c, 'goods_receipt', input.receipt_date),
        id = await this.repo.insert(
          q,
          {
            companyId: c,
            number,
            date: input.receipt_date,
            orderId: Number(order.id),
            supplierId: Number(order.supplier_id),
            warehouseId: Number(order.warehouse_id),
            deliveryNumber: input.supplier_delivery_number ?? null,
            reference: input.reference ?? null,
            notes: input.notes ?? null,
            userId: x.userId,
          },
          lines,
        )
      await this.log(q, c, x, 'create', id, number, { status: 'draft', orderId: order.id })
      return { id, receiptNumber: number, status: 'draft' as const }
    })
  }
  async cancel(id: number, c: number, reason: string, x: InvoiceMutationContext) {
    return transaction(async (q) => {
      const h = await this.repo.find(q, id, c, true)
      if (!h) throw new NotFoundError('Penerimaan barang tidak ditemukan')
      if (h.status !== 'draft')
        throw new ConflictError('Hanya penerimaan Draft yang dapat dibatalkan')
      await this.repo.transition(
        q,
        id,
        c,
        ['draft'],
        "status='cancelled',cancelled_by=?,cancelled_at=NOW(),cancellation_reason=?",
        [x.userId, reason],
      )
      await this.log(q, c, x, 'cancel', id, String(h.receipt_number), {
        status: 'cancelled',
        reason,
      })
      return { id, status: 'cancelled' as const }
    })
  }
  async post(id: number, c: number, x: InvoiceMutationContext) {
    return transaction(async (q) => {
      const h = await this.repo.find(q, id, c, true)
      if (!h) throw new NotFoundError('Penerimaan barang tidak ditemukan')
      if (h.status !== 'draft')
        throw new ConflictError('Hanya penerimaan Draft yang dapat diposting')
      const order = await this.repo.order(q, Number(h.purchase_order_id), c)
      if (!order) {
        throw new ConflictError('Purchase order tidak lagi aktif untuk menerima barang')
      }
      const grni = await this.repo.setting(q, c, 'goods_received_not_invoiced_account_id')
      if (!grni)
        throw new ValidationError(
          'Akun Goods Received Not Invoiced belum dikonfigurasi pada Settings',
        )
      const lines = await this.repo.lines(q, id),
        debits = new Map<number, string>(),
        movementIds: number[] = []
      let total = '0.00'
      for (const l of lines) {
        const amount = String(l.unit_cost),
          lineTotal = multiplyDecimal(String(l.quantity), 4, amount, 6, 2)
        total = addDecimal([total, lineTotal])
        const account = Number(
          l.item_type === 'inventory' ? l.inventory_account_id : l.purchase_account_id,
        )
        if (!account)
          throw new ValidationError(`Akun penerimaan item ${l.item_code} belum dikonfigurasi`)
        debits.set(account, addDecimal([debits.get(account) ?? '0', lineTotal]))
        if (l.item_type === 'inventory') {
          const m = await this.inventory.applyMovement(q, {
            companyId: c,
            itemId: Number(l.item_id),
            warehouseId: Number(h.warehouse_id),
            direction: 'in',
            quantity: String(l.quantity),
            unitCost: String(l.unit_cost),
            transactionType: 'goods_receipt',
            transactionId: id,
            sourceLineId: Number(l.id),
            transactionNumber: String(h.receipt_number),
            movementDate: String(h.receipt_date).slice(0, 10),
            reference: h.reference ? String(h.reference) : null,
            postingKey: `goods-receipt:${id}:line:${l.id}`,
            userId: x.userId,
          })
          movementIds.push(m.movementId)
          await q.execute('UPDATE goods_receipt_lines SET inventory_movement_id=? WHERE id=?', [
            m.movementId,
            l.id,
          ])
        }
        await q.execute(
          'UPDATE purchase_order_lines SET received_quantity=received_quantity+? WHERE id=?',
          [l.quantity, l.purchase_order_line_id],
        )
      }
      const journals: JournalLineInput[] = [...debits].map(([accountId, debit]) => ({
        accountId,
        debit,
        credit: '0',
        description: String(h.receipt_number),
      }))
      journals.push({
        accountId: grni,
        debit: '0',
        credit: total,
        description: `GRNI ${h.receipt_number}`,
      })
      const journalId = await this.posting.createPostedJournal(q, {
        companyId: c,
        sourceType: 'goods_receipt',
        sourceId: id,
        date: String(h.receipt_date).slice(0, 10),
        reference: String(h.receipt_number),
        description: `Penerimaan ${h.receipt_number}`,
        lines: journals,
        context: x,
      })
      if (movementIds.length)
        await q.execute(
          `UPDATE inventory_movements SET journal_id=? WHERE id IN(${movementIds.map(() => '?').join(',')})`,
          [journalId, ...movementIds],
        )
      await this.repo.transition(
        q,
        id,
        c,
        ['draft'],
        "status='posted',journal_id=?,posted_by=?,posted_at=NOW()",
        [journalId, x.userId],
      )
      const orderStatus = await this.repo.refreshOrder(q, Number(h.purchase_order_id))
      await this.log(q, c, x, 'post', id, String(h.receipt_number), {
        status: 'posted',
        journalId,
        orderStatus,
      })
      return { id, status: 'posted' as const, journalId, orderStatus }
    })
  }
  async reverse(id: number, c: number, date: string, reason: string, x: InvoiceMutationContext) {
    return transaction(async (q) => {
      const h = await this.repo.find(q, id, c, true)
      if (!h) throw new NotFoundError('Penerimaan barang tidak ditemukan')
      if (h.status !== 'posted')
        throw new ConflictError('Hanya penerimaan Posted yang dapat direversal')
      const billed = await this.repo.lines(q, id)
      if (billed.some((l) => compareDecimal(String(l.billed_quantity), '0', 4) > 0))
        throw new ConflictError('Penerimaan yang sudah ditagihkan tidak dapat direversal')
      const reversalJournalId = await this.posting.reversePostedJournal(q, {
          companyId: c,
          journalId: Number(h.journal_id),
          date,
          reason,
          context: x,
          sourceType: 'goods_receipt_reversal',
          sourceId: id,
        }),
        movementIds: number[] = []
      for (const m of await this.repo.movements(q, c, id)) {
        const r = await this.inventory.reverseMovement(q, {
          companyId: c,
          movementId: Number(m.id),
          movementDate: date,
          transactionType: 'goods_receipt_reversal',
          transactionId: id,
          transactionNumber: String(h.receipt_number),
          userId: x.userId,
          reference: reason,
        })
        movementIds.push(r.movementId)
      }
      if (movementIds.length)
        await q.execute(
          `UPDATE inventory_movements SET journal_id=? WHERE id IN(${movementIds.map(() => '?').join(',')})`,
          [reversalJournalId, ...movementIds],
        )
      for (const l of billed)
        await q.execute(
          'UPDATE purchase_order_lines SET received_quantity=GREATEST(0,received_quantity-?) WHERE id=?',
          [l.quantity, l.purchase_order_line_id],
        )
      await this.repo.transition(
        q,
        id,
        c,
        ['posted'],
        "status='reversed',reversal_journal_id=?,reversed_by=?,reversed_at=NOW()",
        [reversalJournalId, x.userId],
      )
      const orderStatus = await this.repo.refreshOrder(q, Number(h.purchase_order_id))
      await this.log(q, c, x, 'reverse', id, String(h.receipt_number), {
        status: 'reversed',
        reversalJournalId,
        reason,
      })
      return { id, status: 'reversed' as const, reversalJournalId, orderStatus }
    })
  }
  private log(
    q: any,
    c: number,
    x: InvoiceMutationContext,
    a: string,
    id: number,
    n: string,
    v: any,
  ) {
    return this.audit.log(q, {
      companyId: c,
      userId: x.userId,
      module: 'goods-receipts',
      action: a,
      recordType: 'goods_receipt',
      recordId: id,
      recordNumber: n,
      newValue: v,
      requestId: x.requestId,
      ip: x.ip,
    })
  }
}
