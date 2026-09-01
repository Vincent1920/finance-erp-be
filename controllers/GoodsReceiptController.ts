import type { Context } from 'hono'
import { GoodsReceiptService } from '../services/GoodsReceiptService'
import type { InvoiceMutationContext } from '../services/InvoiceDomainSupport'
import { created, ok, paginated } from '../utils/response'
import { requestIp } from '../utils/request-context'
import {
  goodsReceiptIdSchema,
  goodsReceiptListSchema,
  goodsReceiptReasonSchema,
  goodsReceiptReverseSchema,
  goodsReceiptSchema,
} from '../validators/goods-receipt.validator'
export class GoodsReceiptController {
  constructor(private service = new GoodsReceiptService()) {}
  list = async (c: Context) => {
    const q = goodsReceiptListSchema.parse(c.req.query()),
      r = await this.service.list(c.get('user').companyId, q)
    return paginated(c, r.rows, r)
  }
  get = async (c: Context) => ok(c, await this.service.get(this.id(c), c.get('user').companyId))
  create = async (c: Context) =>
    created(
      c,
      await this.service.create(
        c.get('user').companyId,
        goodsReceiptSchema.parse(await c.req.json()),
        this.ctx(c),
      ),
      'Penerimaan barang berhasil dibuat',
    )
  post = async (c: Context) =>
    ok(
      c,
      await this.service.post(this.id(c), c.get('user').companyId, this.ctx(c)),
      'Penerimaan barang berhasil diposting',
    )
  cancel = async (c: Context) => {
    const { reason } = goodsReceiptReasonSchema.parse(await c.req.json())
    return ok(
      c,
      await this.service.cancel(this.id(c), c.get('user').companyId, reason, this.ctx(c)),
      'Penerimaan barang dibatalkan',
    )
  }
  reverse = async (c: Context) => {
    const v = goodsReceiptReverseSchema.parse(await c.req.json())
    return ok(
      c,
      await this.service.reverse(
        this.id(c),
        c.get('user').companyId,
        v.date,
        v.reason,
        this.ctx(c),
      ),
      'Penerimaan barang direversal',
    )
  }
  private id(c: Context) {
    return goodsReceiptIdSchema.parse(c.req.param('id'))
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
