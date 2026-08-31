import { transaction } from '../config/database'
import { SalesReturnRepository } from '../repositories/SalesReturnRepository'
import { ConflictError, NotFoundError, ValidationError } from '../utils/AppError'
import {
  addDecimal,
  compareDecimal,
  divideDecimal,
  multiplyDecimal,
  subtractDecimal,
} from '../utils/decimal'
import type { SalesReturnInput } from '../validators/sales-return.validator'
import { AuditService } from './AuditService'
import { InventoryCostingService } from './InventoryCostingService'
import { NumberSequenceService } from './NumberSequenceService'
import { PostingService, type JournalLineInput } from './PostingService'
import type { InvoiceMutationContext } from './InvoiceDomainSupport'
export class SalesReturnService {
  constructor(
    private repo = new SalesReturnRepository(),
    private seq = new NumberSequenceService(),
    private posting = new PostingService(),
    private inventory = new InventoryCostingService(),
    private audit = new AuditService(),
  ) {}
  list(c: number, q: Parameters<SalesReturnRepository['list']>[1]) {
    return this.repo.list(c, q)
  }
  async get(id: number, c: number) {
    const r = await this.repo.detail(id, c)
    if (!r) throw new NotFoundError('Retur penjualan tidak ditemukan')
    return r
  }
  async create(companyId: number, input: SalesReturnInput, ctx: InvoiceMutationContext) {
    return transaction(async (connection) => {
      const invoice = await this.repo.invoice(connection, input.sales_invoice_id, companyId)
      if (!invoice) throw new NotFoundError('Sales invoice posted tidak ditemukan')
      if (input.return_date < this.date(invoice.invoice_date))
        throw new ValidationError('Tanggal retur tidak boleh sebelum tanggal invoice')
      const source = await this.repo.invoiceLines(connection, input.sales_invoice_id),
        byId = new Map(source.map((x) => [Number(x.id), x]))
      let subtotal = '0.00',
        discount = '0.00',
        tax = '0.00',
        grand = '0.00',
        base = '0.00'
      const lines = input.lines.map((requested, index) => {
        const line = byId.get(requested.sales_invoice_line_id)
        if (!line) throw new NotFoundError(`Baris invoice ${index + 1} tidak ditemukan`)
        const available = subtractDecimal(
          String(line.quantity),
          String(line.reserved_return_quantity),
          4,
        )
        if (compareDecimal(requested.quantity, available, 4) > 0)
          throw new ValidationError(`Kuantitas retur baris ${index + 1} melebihi sisa ${available}`)
        const ratio = divideDecimal(requested.quantity, 4, String(line.quantity), 4, 8),
          gross = multiplyDecimal(
            multiplyDecimal(requested.quantity, 4, String(line.unit_price), 2, 4),
            4,
            '1',
            0,
            2,
          ),
          disc = multiplyDecimal(String(line.discount), 2, ratio, 8, 2),
          net = subtractDecimal(gross, disc),
          lineTax = multiplyDecimal(String(line.tax_amount), 2, ratio, 8, 2),
          lineGrand = addDecimal([net, lineTax]),
          lineBase = multiplyDecimal(net, 2, String(invoice.exchange_rate), 8),
          cogs = multiplyDecimal(String(line.cogs_amount), 2, ratio, 8, 2)
        subtotal = addDecimal([subtotal, gross])
        discount = addDecimal([discount, disc])
        tax = addDecimal([tax, lineTax])
        grand = addDecimal([grand, lineGrand])
        base = addDecimal([base, multiplyDecimal(lineGrand, 2, String(invoice.exchange_rate), 8)])
        return {
          invoiceLineId: Number(line.id),
          itemId: Number(line.item_id),
          description: line.description,
          quantity: requested.quantity,
          unitId: Number(line.unit_id),
          unitPrice: String(line.unit_price),
          discount: disc,
          taxCodeId: line.tax_code_id ? Number(line.tax_code_id) : null,
          taxRate: String(line.tax_rate),
          taxAmount: lineTax,
          subtotal: net,
          baseSubtotal: lineBase,
          cogsAmount: cogs,
          reason: requested.reason ?? null,
        }
      })
      const number = await this.seq.next(connection, companyId, 'sales_return', input.return_date),
        id = await this.repo.insert(
          connection,
          {
            companyId,
            number,
            date: input.return_date,
            invoiceId: Number(invoice.id),
            customerId: Number(invoice.customer_id),
            warehouseId: invoice.warehouse_id ? Number(invoice.warehouse_id) : null,
            reference: input.reference ?? null,
            currency: String(invoice.currency),
            exchangeRate: String(invoice.exchange_rate),
            subtotal,
            discount,
            tax,
            grandTotal: grand,
            baseGrandTotal: base,
            reason: input.reason,
            userId: ctx.userId,
          },
          lines,
        )
      await this.log(connection, companyId, ctx, 'create', id, number, {
        status: 'draft',
        grandTotal: grand,
      })
      return { id, returnNumber: number, status: 'draft' as const }
    })
  }
  submit(id: number, c: number, x: InvoiceMutationContext) {
    return this.change(
      id,
      c,
      ['draft', 'rejected'],
      "status='pending_approval',submitted_by=?,submitted_at=NOW()",
      [x.userId],
      'submit',
      x,
    )
  }
  approve(id: number, c: number, x: InvoiceMutationContext) {
    return this.change(
      id,
      c,
      ['pending_approval'],
      "status='approved',approved_by=?,approved_at=NOW()",
      [x.userId],
      'approve',
      x,
    )
  }
  reject(id: number, c: number, reason: string, x: InvoiceMutationContext) {
    return this.change(
      id,
      c,
      ['pending_approval'],
      "status='rejected',rejected_by=?,rejected_at=NOW(),rejection_reason=?",
      [x.userId, reason],
      'reject',
      x,
    )
  }
  cancel(id: number, c: number, reason: string, x: InvoiceMutationContext) {
    return this.change(
      id,
      c,
      ['draft', 'rejected'],
      "status='cancelled',cancelled_by=?,cancelled_at=NOW(),cancellation_reason=?",
      [x.userId, reason],
      'cancel',
      x,
    )
  }
  async post(id: number, companyId: number, ctx: InvoiceMutationContext) {
    return transaction(async (connection) => {
      const h = await this.repo.find(connection, id, companyId, true)
      if (!h) throw new NotFoundError('Retur penjualan tidak ditemukan')
      if (h.status !== 'approved')
        throw new ConflictError('Hanya retur Approved yang dapat diposting')
      if (!h.receivable_account_id)
        throw new ValidationError('Akun piutang pelanggan belum dikonfigurasi')
      const lines = await this.repo.lines(connection, id),
        journals: JournalLineInput[] = [
          {
            accountId: Number(h.receivable_account_id),
            debit: '0',
            credit: String(h.base_grand_total),
            description: String(h.return_number),
          },
        ],
        debits = new Map<number, string>(),
        credits = new Map<number, string>(),
        movementIds: number[] = []
      for (const l of lines) {
        this.add(
          debits,
          Number(l.revenue_account_id ?? (await this.revenue(connection, l.item_id))),
          String(l.base_subtotal),
          'Akun pendapatan belum dikonfigurasi',
        )
        if (compareDecimal(String(l.tax_amount), '0') > 0)
          this.add(
            debits,
            Number(l.output_tax_account_id),
            multiplyDecimal(String(l.tax_amount), 2, String(h.exchange_rate), 8),
            'Akun pajak keluaran belum dikonfigurasi',
          )
        if (l.item_type === 'inventory') {
          if (!h.warehouse_id) throw new ValidationError('Gudang retur belum dikonfigurasi')
          const unitCost = divideDecimal(String(l.cogs_amount), 2, String(l.quantity), 4, 6),
            m = await this.inventory.applyMovement(connection, {
              companyId,
              itemId: Number(l.item_id),
              warehouseId: Number(h.warehouse_id),
              direction: 'in',
              quantity: String(l.quantity),
              unitCost,
              transactionType: 'sales_return',
              transactionId: id,
              sourceLineId: Number(l.id),
              transactionNumber: String(h.return_number),
              movementDate: this.date(h.return_date),
              postingKey: `sales-return:${id}:line:${l.id}`,
              userId: ctx.userId,
            })
          movementIds.push(m.movementId)
          this.add(
            debits,
            Number(l.inventory_account_id),
            m.totalCost,
            'Akun persediaan belum dikonfigurasi',
          )
          this.add(
            credits,
            Number(l.purchase_account_id),
            m.totalCost,
            'Akun COGS belum dikonfigurasi',
          )
        }
        await connection.execute(
          'UPDATE sales_invoice_lines SET returned_quantity=returned_quantity+? WHERE id=?',
          [l.quantity, l.sales_invoice_line_id],
        )
      }
      for (const [a, v] of debits) journals.push({ accountId: a, debit: v, credit: '0' })
      for (const [a, v] of credits) journals.push({ accountId: a, debit: '0', credit: v })
      const journalId = await this.posting.createPostedJournal(connection, {
        companyId,
        sourceType: 'sales_return',
        sourceId: id,
        date: this.date(h.return_date),
        reference: String(h.return_number),
        description: `Retur ${h.return_number}`,
        currency: String(h.currency),
        exchangeRate: String(h.exchange_rate),
        lines: journals,
        context: ctx,
      })
      if (movementIds.length)
        await connection.execute(
          `UPDATE inventory_movements SET journal_id=? WHERE id IN (${movementIds.map(() => '?').join(',')})`,
          [journalId, ...movementIds],
        )
      await this.repo.transition(
        connection,
        id,
        companyId,
        ['approved'],
        "status='posted',journal_id=?,posted_by=?,posted_at=NOW()",
        [journalId, ctx.userId],
      )
      await this.log(connection, companyId, ctx, 'post', id, String(h.return_number), {
        status: 'posted',
        journalId,
      })
      return { id, status: 'posted' as const, journalId }
    })
  }

  async reverse(
    id: number,
    companyId: number,
    date: string,
    reason: string,
    ctx: InvoiceMutationContext,
  ) {
    return transaction(async (connection) => {
      const header = await this.repo.find(connection, id, companyId, true)
      if (!header) throw new NotFoundError('Retur penjualan tidak ditemukan')
      if (header.status !== 'posted') {
        throw new ConflictError('Hanya retur Posted yang dapat direversal')
      }
      const reversalJournalId = await this.posting.reversePostedJournal(connection, {
        companyId,
        journalId: Number(header.journal_id),
        date,
        reason,
        context: ctx,
        sourceType: 'sales_return_reversal',
        sourceId: id,
      })
      const reversalMovementIds: number[] = []
      for (const movement of await this.repo.movements(connection, companyId, id)) {
        const reversed = await this.inventory.reverseMovement(connection, {
          companyId,
          movementId: Number(movement.id),
          movementDate: date,
          transactionType: 'sales_return_reversal',
          transactionId: id,
          transactionNumber: String(header.return_number),
          userId: ctx.userId,
          reference: reason,
        })
        reversalMovementIds.push(reversed.movementId)
      }
      if (reversalMovementIds.length) {
        await connection.execute(
          `UPDATE inventory_movements SET journal_id=? WHERE id IN (${reversalMovementIds.map(() => '?').join(',')})`,
          [reversalJournalId, ...reversalMovementIds],
        )
      }
      for (const line of await this.repo.lines(connection, id)) {
        await connection.execute(
          'UPDATE sales_invoice_lines SET returned_quantity=GREATEST(0,returned_quantity-?) WHERE id=?',
          [line.quantity, line.sales_invoice_line_id],
        )
      }
      await this.repo.transition(
        connection,
        id,
        companyId,
        ['posted'],
        "status='reversed',reversal_journal_id=?,reversed_by=?,reversed_at=NOW()",
        [reversalJournalId, ctx.userId],
      )
      await this.log(connection, companyId, ctx, 'reverse', id, String(header.return_number), {
        status: 'reversed',
        reversalJournalId,
        reason,
      })
      return { id, status: 'reversed' as const, reversalJournalId }
    })
  }
  private async revenue(c: any, itemId: number) {
    const [r] = await c.execute('SELECT sales_account_id FROM items WHERE id=?', [itemId])
    return r[0]?.sales_account_id
  }
  private add(m: Map<number, string>, a: number, v: string, msg: string) {
    if (!a) throw new ValidationError(msg)
    m.set(a, addDecimal([m.get(a) ?? '0', v]))
  }
  private async change(
    id: number,
    c: number,
    from: string[],
    fields: string,
    vals: any[],
    action: string,
    x: InvoiceMutationContext,
  ) {
    return transaction(async (q) => {
      const h = await this.repo.find(q, id, c, true)
      if (!h) throw new NotFoundError('Retur penjualan tidak ditemukan')
      if (!from.includes(String(h.status))) throw new ConflictError('Status retur tidak valid')
      await this.repo.transition(q, id, c, from, fields, vals)
      await this.log(q, c, x, action, id, String(h.return_number), { status: action })
      return { id, status: action }
    })
  }
  private date(v: Date | string) {
    return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)
  }
  private log(
    c: any,
    companyId: number,
    x: InvoiceMutationContext,
    action: string,
    id: number,
    n: string,
    value: any,
  ) {
    return this.audit.log(c, {
      companyId,
      userId: x.userId,
      module: 'sales-returns',
      action,
      recordType: 'sales_return',
      recordId: id,
      recordNumber: n,
      newValue: value,
      requestId: x.requestId,
      ip: x.ip,
    })
  }
}
