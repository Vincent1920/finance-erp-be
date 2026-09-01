import type { Context } from 'hono'
import { PurchaseOrderService } from '../services/PurchaseOrderService'
import { created, ok, paginated } from '../utils/response'
import { requestIp } from '../utils/request-context'
import {
  purchaseOrderIdSchema,
  purchaseOrderListSchema,
  purchaseOrderReasonSchema,
  purchaseOrderSchema,
  purchaseOrderUpdateSchema,
} from '../validators/purchase-order.validator'
import type { InvoiceMutationContext } from '../services/InvoiceDomainSupport'
export class PurchaseOrderController {
  constructor(private service = new PurchaseOrderService()) {}
  list = async (c: Context) => {
    const q = purchaseOrderListSchema.parse(c.req.query()),
      r = await this.service.list(c.get('user').companyId, q)
    return paginated(c, r.rows, r)
  }
  get = async (c: Context) => ok(c, await this.service.get(this.id(c), c.get('user').companyId))
  create = async (c: Context) =>
    created(
      c,
      await this.service.create(
        c.get('user').companyId,
        purchaseOrderSchema.parse(await c.req.json()),
        this.ctx(c),
      ),
      'Purchase order berhasil dibuat',
    )
  update = async (c: Context) =>
    ok(
      c,
      await this.service.update(
        this.id(c),
        c.get('user').companyId,
        purchaseOrderUpdateSchema.parse(await c.req.json()),
        this.ctx(c),
      ),
      'Purchase order diperbarui',
    )
  confirm = async (c: Context) =>
    ok(
      c,
      await this.service.confirm(this.id(c), c.get('user').companyId, this.ctx(c)),
      'Purchase order dikonfirmasi',
    )
  cancel = async (c: Context) => {
    const { reason } = purchaseOrderReasonSchema.parse(await c.req.json())
    return ok(
      c,
      await this.service.cancel(this.id(c), c.get('user').companyId, reason, this.ctx(c)),
      'Purchase order dibatalkan',
    )
  }
  private id(c: Context) {
    return purchaseOrderIdSchema.parse(c.req.param('id'))
  }
  private ctx(c: Context): InvoiceMutationContext {
    return {
      userId: c.get('user').id,
      requestId: c.get('requestId'),
      ip: requestIp(c),
      source: 'manual',
    }
  }
}
