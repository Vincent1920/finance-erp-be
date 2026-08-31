import type { Context } from 'hono'
import { SalesReturnService } from '../services/SalesReturnService'
import { created, ok, paginated } from '../utils/response'
import { requestIp } from '../utils/request-context'
import {
  salesReturnIdSchema,
  salesReturnListSchema,
  salesReturnReasonSchema,
  salesReturnReverseSchema,
  salesReturnSchema,
} from '../validators/sales-return.validator'
import type { InvoiceMutationContext } from '../services/InvoiceDomainSupport'
export class SalesReturnController {
  constructor(private service = new SalesReturnService()) {}
  list = async (c: Context) => {
    const q = salesReturnListSchema.parse(c.req.query()),
      r = await this.service.list(c.get('user').companyId, q)
    return paginated(c, r.rows, r)
  }
  get = async (c: Context) => ok(c, await this.service.get(this.id(c), c.get('user').companyId))
  create = async (c: Context) =>
    created(
      c,
      await this.service.create(
        c.get('user').companyId,
        salesReturnSchema.parse(await c.req.json()),
        this.ctx(c),
      ),
      'Retur penjualan berhasil dibuat',
    )
  submit = async (c: Context) =>
    ok(
      c,
      await this.service.submit(this.id(c), c.get('user').companyId, this.ctx(c)),
      'Retur diajukan',
    )
  approve = async (c: Context) =>
    ok(
      c,
      await this.service.approve(this.id(c), c.get('user').companyId, this.ctx(c)),
      'Retur disetujui',
    )
  reject = async (c: Context) => {
    const { reason } = salesReturnReasonSchema.parse(await c.req.json())
    return ok(
      c,
      await this.service.reject(this.id(c), c.get('user').companyId, reason, this.ctx(c)),
      'Retur ditolak',
    )
  }
  post = async (c: Context) =>
    ok(
      c,
      await this.service.post(this.id(c), c.get('user').companyId, this.ctx(c)),
      'Retur berhasil diposting',
    )
  cancel = async (c: Context) => {
    const { reason } = salesReturnReasonSchema.parse(await c.req.json())
    return ok(
      c,
      await this.service.cancel(this.id(c), c.get('user').companyId, reason, this.ctx(c)),
      'Retur dibatalkan',
    )
  }
  reverse = async (c: Context) => {
    const input = salesReturnReverseSchema.parse(await c.req.json())
    return ok(
      c,
      await this.service.reverse(
        this.id(c),
        c.get('user').companyId,
        input.date,
        input.reason,
        this.ctx(c),
      ),
      'Retur berhasil direversal',
    )
  }
  private id(c: Context) {
    return salesReturnIdSchema.parse(c.req.param('id'))
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
