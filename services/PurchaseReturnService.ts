import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import { db } from '../config/database'
import { idempotentOperation } from './IdempotentOperation'
import { InvoiceRepository } from '../repositories/InvoiceRepository'
import { NumberSequenceService } from './NumberSequenceService'
import { PostingService, type PostingContext, type JournalLineInput } from './PostingService'
import { InventoryCostingService } from './InventoryCostingService'
import { SettlementService } from './SettlementService'
import { AuditService } from './AuditService'
import { ConflictError, NotFoundError, ValidationError } from '../utils/AppError'
import {
  addDecimal,
  subtractDecimal,
  multiplyDecimal,
  divideDecimal,
  compareDecimal,
} from '../utils/decimal'
import type { PurchaseReturnInput } from '../validators/operations.validator'
import type { ReversalInput } from '../validators/operations.validator'
const dateOnly = (value: unknown) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)
export class PurchaseReturnService {
  async list(companyId: number) {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT r.*,i.invoice_number,s.name supplier_name FROM purchase_returns r JOIN purchase_invoices i ON i.id=r.purchase_invoice_id JOIN suppliers s ON s.id=r.supplier_id WHERE r.company_id=? ORDER BY r.return_date DESC,r.id DESC`,
      [companyId],
    )
    return rows
  }
  post(companyId: number, input: PurchaseReturnInput, context: PostingContext) {
    return idempotentOperation(
      companyId,
      input.request_key,
      'purchase-return',
      input,
      async (connection) => {
        const repo = new InvoiceRepository(),
          invoice = await repo.findPurchase(connection, input.invoice_id, companyId, true)
        if (!invoice) throw new NotFoundError('Invoice tidak ditemukan')
        if (!['posted', 'partially_paid', 'paid'].includes(String(invoice.status)))
          throw new ConflictError('Invoice harus sudah posted')
        const date =
          invoice.invoice_date instanceof Date
            ? invoice.invoice_date.toISOString().slice(0, 10)
            : String(invoice.invoice_date).slice(0, 10)
        if (input.date < date)
          throw new ValidationError('Tanggal retur tidak boleh sebelum invoice')
        if (!input.return_stock && !input.adjustment_account_id)
          throw new ValidationError(
            'Pilih akun potongan pembelian untuk pengurangan harga tanpa barang kembali',
          )
        const original = await repo.purchaseLines(connection, input.invoice_id),
          byId = new Map(original.map((r) => [Number(r.id), r]))
        const number = await new NumberSequenceService().next(
          connection,
          companyId,
          'purchase_return',
          input.date,
        )
        const [created] = await connection.execute<ResultSetHeader>(
          `INSERT INTO purchase_returns(company_id,return_number,return_date,purchase_invoice_id,supplier_id,warehouse_id,reference,currency,exchange_rate,reason,status,created_by,return_stock) VALUES(?,?,?,?,?,?,?,?,?,?,'draft',?,?)`,
          [
            companyId,
            number,
            input.date,
            input.invoice_id,
            invoice.supplier_id,
            invoice.warehouse_id,
            input.reference,
            invoice.currency,
            invoice.exchange_rate,
            input.reason,
            context.userId,
            input.return_stock,
          ],
        )
        let subtotal = '0.00',
          tax = '0.00',
          grand = '0.00',
          baseTotal = '0.00'
        const journals: JournalLineInput[] = [],
          movements: number[] = []
        const push = (accountId: number, amount: string, credit: boolean) => {
          if (compareDecimal(amount, '0') > 0)
            journals.push({
              accountId,
              debit: credit ? '0' : amount,
              credit: credit ? amount : '0',
            })
        }
        for (const [index, line] of input.lines.entries()) {
          const source = byId.get(line.invoice_line_id)
          if (!source) throw new ValidationError('Baris tidak berasal dari invoice ini')
          const [used] = await connection.execute<RowDataPacket[]>(
            `SELECT COALESCE(SUM(l.quantity),0) quantity FROM purchase_return_lines l JOIN purchase_returns r ON r.id=l.purchase_return_id WHERE l.purchase_invoice_line_id=? AND r.company_id=? AND r.status NOT IN('cancelled','rejected','reversed')`,
            [line.invoice_line_id, companyId],
          )
          if (
            compareDecimal(
              line.quantity,
              subtractDecimal(String(source.quantity), String(used[0]!.quantity), 4),
              4,
            ) > 0
          )
            throw new ConflictError('Kuantitas retur melebihi sisa invoice')
          const ratio = divideDecimal(line.quantity, 4, String(source.quantity), 4, 8)
          const stockQuantity = multiplyDecimal(
            String(source.stock_quantity ?? source.quantity),
            4,
            ratio,
            8,
            4,
          )
          const net = multiplyDecimal(String(source.subtotal), 2, ratio, 8),
            lineTax = multiplyDecimal(String(source.tax_amount), 2, ratio, 8),
            baseNet = multiplyDecimal(net, 2, String(invoice.exchange_rate), 8),
            baseTax = multiplyDecimal(lineTax, 2, String(invoice.exchange_rate), 8)
          const withholding = multiplyDecimal(String(source.withholding_amount ?? 0), 2, ratio, 8)
          const baseWithholding = multiplyDecimal(withholding, 2, String(invoice.exchange_rate), 8)
          const lineGrand = subtractDecimal(addDecimal([net, lineTax]), withholding),
            baseGrand = subtractDecimal(addDecimal([baseNet, baseTax]), baseWithholding)
          subtotal = addDecimal([subtotal, net])
          tax = addDecimal([tax, lineTax])
          grand = addDecimal([grand, lineGrand])
          baseTotal = addDecimal([baseTotal, baseGrand])
          let movementId: number | null = null
          if (input.return_stock && source.item_type === 'inventory') {
            if (!invoice.warehouse_id) throw new ValidationError('Gudang invoice tidak tersedia')
            const m = await new InventoryCostingService().applyMovement(connection, {
              companyId,
              itemId: Number(source.item_id),
              warehouseId: Number(invoice.warehouse_id),
              direction: 'out',
              quantity: stockQuantity,
              transactionType: 'purchase_return',
              transactionId: created.insertId,
              transactionNumber: number,
              movementDate: input.date,
              postingKey: `purchase-return:${created.insertId}:${line.invoice_line_id}`,
              userId: context.userId,
            })
            movementId = m.movementId
            movements.push(movementId)
            push(Number(source.inventory_account_id), m.totalCost, true)
            const difference = subtractDecimal(baseNet, m.totalCost)
            if (compareDecimal(difference, '0') !== 0) {
              if (!input.adjustment_account_id)
                throw new ValidationError(
                  'Pilih akun selisih nilai retur karena biaya rata-rata berbeda dari harga invoice',
                )
              push(
                input.adjustment_account_id,
                compareDecimal(difference, '0') > 0 ? difference : subtractDecimal('0', difference),
                compareDecimal(difference, '0') > 0,
              )
            }
          } else
            push(
              input.return_stock ? Number(source.expense_account_id) : input.adjustment_account_id!,
              baseNet,
              true,
            )
          push(Number(source.input_tax_account_id), baseTax, true)
          push(Number(source.withholding_account_id), baseWithholding, false)
          await connection.execute(
            `INSERT INTO purchase_return_lines(purchase_return_id,purchase_invoice_line_id,line_number,item_id,description,quantity,stock_quantity,unit_id,unit_price,discount,tax_code_id,tax_rate,tax_amount,subtotal,base_subtotal,reason,inventory_movement_id) VALUES(?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?)`,
            [
              created.insertId,
              line.invoice_line_id,
              index + 1,
              source.item_id,
              source.description,
              line.quantity,
              stockQuantity,
              source.unit_id,
              source.unit_price,
              source.tax_code_id,
              source.tax_rate,
              lineTax,
              net,
              baseNet,
              input.reason,
              movementId,
            ],
          )
        }
        push(Number(invoice.payable_account_id), baseTotal, false)
        const journalId = await new PostingService().createPostedJournal(connection, {
          companyId,
          sourceType: 'purchase_return',
          sourceId: created.insertId,
          date: input.date,
          reference: number,
          description: `${input.return_stock ? 'Retur pembelian' : 'Pengurangan harga'} ${invoice.invoice_number}`,
          context,
          lines: journals,
        })
        await connection.execute(
          `UPDATE purchase_returns SET subtotal=?,tax=?,grand_total=?,base_grand_total=?,status='posted',journal_id=?,posted_by=?,posted_at=NOW() WHERE id=?`,
          [subtotal, tax, grand, baseTotal, journalId, context.userId, created.insertId],
        )
        for (const id of movements)
          await connection.execute('UPDATE inventory_movements SET journal_id=? WHERE id=?', [
            journalId,
            id,
          ])
        await new SettlementService().refreshInvoice(
          connection,
          companyId,
          false,
          input.invoice_id,
          context.userId,
        )
        await new AuditService().log(connection, {
          companyId,
          userId: context.userId,
          module: 'purchase-returns',
          action: 'post',
          recordType: 'purchase_return',
          recordId: created.insertId,
          recordNumber: number,
          newValue: { ...input, grand, journalId },
        })
        return { id: created.insertId, number, journalId, status: 'posted' }
      },
    )
  }
  reverse(companyId: number, id: number, input: ReversalInput, context: PostingContext) {
    return idempotentOperation(
      companyId,
      input.request_key,
      'purchase-return-reverse',
      { id, ...input },
      async (connection) => {
        const [rows] = await connection.execute<RowDataPacket[]>(
          'SELECT * FROM purchase_returns WHERE id=? AND company_id=? FOR UPDATE',
          [id, companyId],
        )
        const header = rows[0]
        if (!header) throw new NotFoundError('Retur pembelian tidak ditemukan')
        if (header.status !== 'posted')
          throw new ConflictError('Hanya retur posted yang dapat direversal')
        if (input.date < dateOnly(header.return_date))
          throw new ValidationError('Tanggal reversal tidak boleh sebelum retur')
        const [matched] = await connection.execute<RowDataPacket[]>(
          `SELECT m.id FROM bank_reconciliation_matches m JOIN journal_lines l ON l.id=m.journal_line_id WHERE l.journal_id=? AND m.status='confirmed' LIMIT 1`,
          [header.journal_id],
        )
        if (matched.length) throw new ConflictError('Lepaskan rekonsiliasi sebelum reversal retur')
        const reversalJournalId = await new PostingService().reversePostedJournal(connection, {
          companyId,
          journalId: Number(header.journal_id),
          date: input.date,
          reason: input.reason,
          context,
          sourceType: 'purchase_return_reversal',
          sourceId: id,
        })
        const [movements] = await connection.execute<RowDataPacket[]>(
          "SELECT * FROM inventory_movements WHERE company_id=? AND transaction_type='purchase_return' AND transaction_id=? AND is_reversal=FALSE FOR UPDATE",
          [companyId, id],
        )
        const reversed: number[] = []
        for (const movement of movements) {
          const result = await new InventoryCostingService().reverseMovement(connection, {
            companyId,
            movementId: Number(movement.id),
            movementDate: input.date,
            transactionType: 'purchase_return_reversal',
            transactionId: id,
            transactionNumber: String(header.return_number),
            userId: context.userId,
            reference: input.reason,
          })
          reversed.push(result.movementId)
        }
        if (reversed.length)
          await connection.execute(
            `UPDATE inventory_movements SET journal_id=? WHERE id IN (${reversed.map(() => '?').join(',')})`,
            [reversalJournalId, ...reversed],
          )
        await connection.execute(
          "UPDATE purchase_returns SET status='reversed',reversal_journal_id=?,reversed_by=?,reversed_at=NOW() WHERE id=?",
          [reversalJournalId, context.userId, id],
        )
        await new SettlementService().refreshInvoice(
          connection,
          companyId,
          false,
          Number(header.purchase_invoice_id),
          context.userId,
        )
        await new AuditService().log(connection, {
          companyId,
          userId: context.userId,
          module: 'purchase-returns',
          action: 'reverse',
          recordType: 'purchase_return',
          recordId: id,
          recordNumber: String(header.return_number),
          newValue: { reversalJournalId, reason: input.reason },
        })
        return { id, status: 'reversed', reversalJournalId }
      },
    )
  }
}
