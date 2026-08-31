import type { RowDataPacket } from 'mysql2/promise'

import { transaction } from '../config/database'
import { SalesOrderRepository, type SalesOrderLineWrite, type SalesOrderWrite } from '../repositories/SalesOrderRepository'
import { ConflictError, NotFoundError, ValidationError } from '../utils/AppError'
import { compareDecimal, divideDecimal, multiplyDecimal, subtractDecimal } from '../utils/decimal'
import type {
  SalesOrderConversionInput,
  SalesOrderInput,
  SalesOrderUpdateInput,
} from '../validators/sales.validator'
import { AuditService } from './AuditService'
import { calculateInvoiceLine, calculateInvoiceTotals } from './InvoiceDomainSupport'
import { NumberSequenceService } from './NumberSequenceService'
import { SalesInvoiceService } from './SalesInvoiceService'

export interface SalesOrderContext {
  userId: number
  requestId?: string | null
  ip?: string | null
}

const datePlusDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

export class SalesOrderService {
  constructor(
    private repository = new SalesOrderRepository(),
    private sequences = new NumberSequenceService(),
    private invoices = new SalesInvoiceService(),
    private audit = new AuditService(),
  ) {}

  list(companyId: number, query: Parameters<SalesOrderRepository['list']>[1]) {
    return this.repository.list(companyId, query)
  }

  async get(id: number, companyId: number) {
    const order = await this.repository.detail(id, companyId)
    if (!order) throw new NotFoundError('Sales order tidak ditemukan')
    return order
  }

  async create(companyId: number, input: SalesOrderInput, context: SalesOrderContext) {
    return transaction(async (connection) => {
      const orderNumber = await this.sequences.next(connection, companyId, 'sales_order', input.order_date)
      const prepared = await this.prepare(connection, companyId, orderNumber, input, context.userId)
      const id = await this.repository.insert(connection, prepared)
      await this.audit.log(connection, {
        companyId,
        userId: context.userId,
        module: 'sales-orders',
        action: 'create',
        recordType: 'sales_order',
        recordId: id,
        recordNumber: orderNumber,
        newValue: { status: 'draft', grandTotal: prepared.grandTotal, lineCount: prepared.lines.length },
        requestId: context.requestId,
        ip: context.ip,
      })
      return { id, orderNumber, status: 'draft' as const }
    })
  }

  async update(
    id: number,
    companyId: number,
    input: SalesOrderUpdateInput,
    context: SalesOrderContext,
  ) {
    return transaction(async (connection) => {
      const current = await this.repository.find(id, companyId, connection, true)
      if (!current) throw new NotFoundError('Sales order tidak ditemukan')
      if (current.status !== 'draft') throw new ConflictError('Hanya sales order Draft yang dapat diedit')
      const prepared = await this.prepare(
        connection,
        companyId,
        String(current.order_number),
        input,
        context.userId,
      )
      if (!(await this.repository.update(connection, id, input.version, prepared))) {
        throw new ConflictError('Sales order telah berubah; muat ulang sebelum menyimpan')
      }
      await this.audit.log(connection, {
        companyId,
        userId: context.userId,
        module: 'sales-orders',
        action: 'update',
        recordType: 'sales_order',
        recordId: id,
        recordNumber: String(current.order_number),
        oldValue: { version: current.version },
        newValue: { version: input.version + 1, grandTotal: prepared.grandTotal },
        requestId: context.requestId,
        ip: context.ip,
      })
      return { id, version: input.version + 1 }
    })
  }

  async confirm(id: number, companyId: number, context: SalesOrderContext) {
    return transaction(async (connection) => {
      const current = await this.repository.find(id, companyId, connection, true)
      if (!current) throw new NotFoundError('Sales order tidak ditemukan')
      if (current.status !== 'draft') throw new ConflictError(`Sales order ${current.status} tidak dapat dikonfirmasi`)
      if (!(await this.repository.transition(
        connection, id, companyId, ['draft'],
        "status = 'confirmed', confirmed_by = ?, confirmed_at = NOW()", [context.userId],
      ))) throw new ConflictError('Sales order gagal dikonfirmasi karena status berubah')
      await this.audit.log(connection, {
        companyId, userId: context.userId, module: 'sales-orders', action: 'confirm',
        recordType: 'sales_order', recordId: id, recordNumber: String(current.order_number),
        oldValue: { status: 'draft' }, newValue: { status: 'confirmed' },
        requestId: context.requestId, ip: context.ip,
      })
      return { id, status: 'confirmed' as const }
    })
  }

  async cancel(id: number, companyId: number, reason: string, context: SalesOrderContext) {
    return transaction(async (connection) => {
      const current = await this.repository.find(id, companyId, connection, true)
      if (!current) throw new NotFoundError('Sales order tidak ditemukan')
      if (!['draft', 'confirmed'].includes(String(current.status))) {
        throw new ConflictError('Sales order yang sudah ditagihkan tidak dapat dibatalkan')
      }
      if (!(await this.repository.transition(
        connection, id, companyId, ['draft', 'confirmed'],
        "status = 'cancelled', cancelled_by = ?, cancelled_at = NOW(), cancellation_reason = ?",
        [context.userId, reason],
      ))) throw new ConflictError('Sales order gagal dibatalkan karena status berubah')
      await this.audit.log(connection, {
        companyId, userId: context.userId, module: 'sales-orders', action: 'cancel',
        recordType: 'sales_order', recordId: id, recordNumber: String(current.order_number),
        oldValue: { status: current.status }, newValue: { status: 'cancelled', reason },
        requestId: context.requestId, ip: context.ip,
      })
      return { id, status: 'cancelled' as const }
    })
  }

  async convertToInvoice(
    id: number,
    companyId: number,
    input: SalesOrderConversionInput,
    context: SalesOrderContext,
  ) {
    return transaction(async (connection) => {
      const order = await this.repository.find(id, companyId, connection, true)
      if (!order) throw new NotFoundError('Sales order tidak ditemukan')
      if (!['confirmed', 'partially_invoiced'].includes(String(order.status))) {
        throw new ConflictError('Hanya sales order Confirmed atau Partially Invoiced yang dapat ditagihkan')
      }
      const orderLines = await this.repository.lines(id, connection)
      const byId = new Map(orderLines.map((line) => [Number(line.id), line]))
      const requested = input.lines ?? orderLines
        .filter((line) => compareDecimal(String(line.quantity), String(line.invoiced_quantity), 4) > 0)
        .map((line) => ({
          sales_order_line_id: Number(line.id),
          quantity: subtractDecimal(String(line.quantity), String(line.invoiced_quantity), 4),
        }))
      if (!requested.length) throw new ConflictError('Seluruh kuantitas sales order sudah ditagihkan')
      if (new Set(requested.map((line) => line.sales_order_line_id)).size !== requested.length) {
        throw new ValidationError('Baris sales order duplikat pada permintaan invoice')
      }

      const selected = requested.map((request, index) => {
        const line = byId.get(request.sales_order_line_id)
        if (!line) throw new NotFoundError(`Baris sales order ${request.sales_order_line_id} tidak ditemukan`)
        const remaining = subtractDecimal(String(line.quantity), String(line.invoiced_quantity), 4)
        if (compareDecimal(request.quantity, remaining, 4) > 0) {
          throw new ValidationError(`Kuantitas invoice baris ${index + 1} melebihi sisa ${remaining}`)
        }
        const discount = compareDecimal(String(line.discount_percent), '0', 4) > 0
          ? '0.00'
          : multiplyDecimal(
              request.quantity, 4,
              divideDecimal(String(line.discount_amount), 2, String(line.quantity), 4, 4), 4, 2,
            )
        return { request, line, discount }
      })

      const invoiceNumber = await this.sequences.next(connection, companyId, 'sales_invoice', input.invoice_date)
      const created = await this.invoices.createImported(
        connection,
        companyId,
        {
          invoiceNumber,
          invoiceDate: input.invoice_date,
          dueDate: datePlusDays(input.invoice_date, Number(order.payment_term_days)),
          customerId: Number(order.customer_id),
          warehouseId: Number(order.warehouse_id),
          reference: String(order.order_number),
          notes: order.notes ? String(order.notes) : null,
          currency: String(order.currency),
          exchangeRate: String(order.exchange_rate),
          importAs: 'draft',
          lines: selected.map(({ request, line, discount }) => ({
            itemId: Number(line.item_id),
            description: line.description ? String(line.description) : null,
            quantity: request.quantity,
            unitId: Number(line.unit_id),
            unitPrice: String(line.unit_price),
            discount,
            discountPercent: String(line.discount_percent),
            taxCodeId: line.tax_code_id ? Number(line.tax_code_id) : null,
          })),
        },
        { ...context, source: 'sales_order' },
      )
      const status = await this.repository.linkInvoice(
        connection,
        id,
        created.id,
        selected.map(({ request }, index) => ({
          orderLineId: request.sales_order_line_id,
          quantity: request.quantity,
          invoiceLineNumber: index + 1,
        })),
      )
      await this.audit.log(connection, {
        companyId, userId: context.userId, module: 'sales-orders', action: 'convert_to_invoice',
        recordType: 'sales_order', recordId: id, recordNumber: String(order.order_number),
        newValue: { status, invoiceId: created.id, invoiceNumber },
        requestId: context.requestId, ip: context.ip,
      })
      return { id: created.id, invoiceNumber, invoiceStatus: created.status, orderStatus: status }
    })
  }

  private async prepare(
    connection: Parameters<Parameters<typeof transaction>[0]>[0],
    companyId: number,
    orderNumber: string,
    input: SalesOrderInput,
    userId: number,
  ): Promise<SalesOrderWrite> {
    const skeleton: SalesOrderWrite = {
      companyId, orderNumber, orderDate: input.order_date, customerId: input.customer_id,
      warehouseId: input.warehouse_id, salesPersonId: input.sales_person_id ?? null,
      paymentTermDays: input.payment_term_days, expectedDate: input.expected_date ?? null,
      reference: input.reference ?? null, currency: input.currency,
      exchangeRate: input.exchange_rate, notes: input.notes ?? null,
      subtotal: '0.00', discount: '0.00', tax: '0.00', grandTotal: '0.00',
      baseGrandTotal: '0.00', userId,
      lines: input.lines.map((line, index) => ({
        lineNumber: index + 1, itemId: line.item_id, description: line.description ?? null,
        quantity: line.quantity, unitId: line.unit_id ?? 0, unitPrice: line.unit_price,
        discountPercent: line.discount_percent, discountAmount: line.discount_amount,
        taxCodeId: line.tax_code_id ?? null, taxRate: '0.0000', taxAmount: '0.00',
        subtotal: '0.00', baseSubtotal: '0.00',
      })),
    }
    const refs = await this.repository.references(connection, companyId, skeleton)
    if (!refs.customer) throw new NotFoundError('Pelanggan tidak ditemukan atau tidak aktif')
    if (!refs.warehouse) throw new NotFoundError('Gudang tidak ditemukan atau tidak aktif')
    if (String(refs.customer.currency).toUpperCase() !== input.currency) {
      throw new ValidationError('Mata uang sales order harus sama dengan mata uang pelanggan')
    }
    const items = new Map(refs.items.map((item: RowDataPacket) => [Number(item.id), item]))
    const taxes = new Map(refs.taxes.map((tax: RowDataPacket) => [Number(tax.id), tax]))
    const calculated = input.lines.map((line, index) => {
      const item = items.get(line.item_id)
      if (!item) throw new NotFoundError(`Item baris ${index + 1} tidak ditemukan atau tidak aktif`)
      const unitId = line.unit_id ?? Number(item.unit_id)
      if (unitId !== Number(item.unit_id)) throw new ValidationError(`Satuan baris ${index + 1} tidak sesuai item`)
      const tax = line.tax_code_id ? taxes.get(line.tax_code_id) : null
      if (line.tax_code_id && !tax) throw new NotFoundError(`Kode pajak baris ${index + 1} tidak ditemukan`)
      const amount = calculateInvoiceLine({
        quantity: line.quantity, unitPrice: line.unit_price,
        discount: line.discount_amount, discountPercent: line.discount_percent,
        taxRate: tax ? String(tax.rate) : '0', exchangeRate: input.exchange_rate,
      })
      return { line, unitId, tax, amount }
    })
    const totals = calculateInvoiceTotals(calculated.map((line) => line.amount), input.exchange_rate)
    if (compareDecimal(totals.grandTotal, '0') <= 0) throw new ValidationError('Total sales order harus lebih dari nol')
    return {
      ...skeleton,
      subtotal: totals.subtotal, discount: totals.discount, tax: totals.tax,
      grandTotal: totals.grandTotal, baseGrandTotal: totals.baseGrandTotal,
      lines: calculated.map<SalesOrderLineWrite>(({ line, unitId, tax, amount }, index) => ({
        lineNumber: index + 1, itemId: line.item_id, description: line.description ?? null,
        quantity: amount.quantity, unitId, unitPrice: amount.unitPrice,
        discountPercent: amount.discountPercent, discountAmount: amount.discount,
        taxCodeId: line.tax_code_id ?? null, taxRate: amount.taxRate,
        taxAmount: amount.taxAmount, subtotal: amount.subtotal, baseSubtotal: amount.baseSubtotal,
      })),
    }
  }
}
