import type { Context } from 'hono'
import {
  PurchaseInvoiceService,
  type InvoiceMutationContext,
} from '../services/PurchaseInvoiceService'
import { created, ok, paginated } from '../utils/response'
import { requestIp } from '../utils/request-context'
import {
  purchaseInvoiceIdSchema,
  purchaseInvoiceListQuerySchema,
  purchaseInvoiceReasonSchema,
  purchaseInvoiceReverseSchema,
  purchaseInvoiceSchema,
  purchaseInvoiceUpdateSchema,
} from '../validators/purchase-invoice.validator'

export class PurchaseInvoiceController {
  constructor(private service = new PurchaseInvoiceService()) {}
  list = async (c: Context) => {
    const result = await this.service.list(
      c.get('user').companyId,
      purchaseInvoiceListQuerySchema.parse(c.req.query()),
    )
    return paginated(c, result.rows, result)
  }
  get = async (c: Context) => ok(c, await this.service.get(this.id(c), c.get('user').companyId))
  create = async (c: Context) =>
    created(
      c,
      await this.service.create(
        c.get('user').companyId,
        purchaseInvoiceSchema.parse(await c.req.json()),
        this.context(c),
      ),
      'Purchase invoice berhasil dibuat',
    )
  update = async (c: Context) =>
    ok(
      c,
      await this.service.update(
        this.id(c),
        c.get('user').companyId,
        purchaseInvoiceUpdateSchema.parse(await c.req.json()),
        this.context(c),
      ),
      'Purchase invoice berhasil diperbarui',
    )
  submit = async (c: Context) =>
    ok(c, await this.service.submit(this.id(c), c.get('user').companyId, this.context(c)))
  approve = async (c: Context) =>
    ok(c, await this.service.approve(this.id(c), c.get('user').companyId, this.context(c)))
  reject = async (c: Context) => {
    const { reason } = purchaseInvoiceReasonSchema.parse(await c.req.json())
    return ok(
      c,
      await this.service.reject(this.id(c), c.get('user').companyId, reason, this.context(c)),
    )
  }
  cancel = async (c: Context) => {
    const { reason } = purchaseInvoiceReasonSchema.parse(await c.req.json())
    return ok(
      c,
      await this.service.cancel(this.id(c), c.get('user').companyId, reason, this.context(c)),
    )
  }
  post = async (c: Context) =>
    ok(c, await this.service.post(this.id(c), c.get('user').companyId, this.context(c)))
  reverse = async (c: Context) => {
    const input = purchaseInvoiceReverseSchema.parse(await c.req.json())
    return ok(
      c,
      await this.service.reverse(
        this.id(c),
        c.get('user').companyId,
        input.date,
        input.reason,
        this.context(c),
      ),
    )
  }
  private id(c: Context) {
    return purchaseInvoiceIdSchema.parse(c.req.param('id'))
  }
  private context(c: Context): InvoiceMutationContext {
    return {
      userId: c.get('user').id,
      requestId: c.get('requestId'),
      ip: requestIp(c),
      source: 'manual',
    }
  }
}
