import type { Context } from 'hono'
import { SalesInvoiceService, type InvoiceMutationContext } from '../services/SalesInvoiceService'
import { created, ok, paginated } from '../utils/response'
import { requestIp } from '../utils/request-context'
import { salesInvoiceIdSchema, salesInvoiceListQuerySchema, salesInvoiceReasonSchema, salesInvoiceReverseSchema, salesInvoiceSchema, salesInvoiceUpdateSchema } from '../validators/sales-invoice.validator'

export class SalesInvoiceController {
  constructor(private service = new SalesInvoiceService()) {}
  list = async (c: Context) => { const query = salesInvoiceListQuerySchema.parse(c.req.query()); const result = await this.service.list(c.get('user').companyId, query); return paginated(c, result.rows, result) }
  get = async (c: Context) => ok(c, await this.service.get(this.id(c), c.get('user').companyId))
  create = async (c: Context) => created(c, await this.service.create(c.get('user').companyId, salesInvoiceSchema.parse(await c.req.json()), this.context(c)), 'Sales invoice berhasil dibuat')
  update = async (c: Context) => ok(c, await this.service.update(this.id(c), c.get('user').companyId, salesInvoiceUpdateSchema.parse(await c.req.json()), this.context(c)), 'Sales invoice berhasil diperbarui')
  submit = async (c: Context) => ok(c, await this.service.submit(this.id(c), c.get('user').companyId, this.context(c)), 'Sales invoice diajukan')
  approve = async (c: Context) => ok(c, await this.service.approve(this.id(c), c.get('user').companyId, this.context(c)), 'Sales invoice disetujui')
  reject = async (c: Context) => { const { reason } = salesInvoiceReasonSchema.parse(await c.req.json()); return ok(c, await this.service.reject(this.id(c), c.get('user').companyId, reason, this.context(c)), 'Sales invoice ditolak') }
  cancel = async (c: Context) => { const { reason } = salesInvoiceReasonSchema.parse(await c.req.json()); return ok(c, await this.service.cancel(this.id(c), c.get('user').companyId, reason, this.context(c)), 'Sales invoice dibatalkan') }
  post = async (c: Context) => ok(c, await this.service.post(this.id(c), c.get('user').companyId, this.context(c)), 'Sales invoice berhasil diposting')
  reverse = async (c: Context) => { const input = salesInvoiceReverseSchema.parse(await c.req.json()); return ok(c, await this.service.reverse(this.id(c), c.get('user').companyId, input.date, input.reason, this.context(c)), 'Sales invoice berhasil direversal') }
  private id(c: Context) { return salesInvoiceIdSchema.parse(c.req.param('id')) }
  private context(c: Context): InvoiceMutationContext { return { userId: c.get('user').id, requestId: c.get('requestId'), ip: requestIp(c), source: 'manual' } }
}
