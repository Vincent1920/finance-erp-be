import type { Context } from 'hono'

import { SalesOrderService, type SalesOrderContext } from '../services/SalesOrderService'
import { created, ok, paginated } from '../utils/response'
import { requestIp } from '../utils/request-context'
import {
  salesOrderCancelSchema,
  salesOrderConversionSchema,
  salesOrderIdSchema,
  salesOrderListQuerySchema,
  salesOrderSchema,
  salesOrderUpdateSchema,
} from '../validators/sales.validator'

export class SalesOrderController {
  constructor(private service = new SalesOrderService()) {}

  list = async (c: Context) => {
    const query = salesOrderListQuerySchema.parse(c.req.query())
    const result = await this.service.list(c.get('user').companyId, query)
    return paginated(c, result.rows, result)
  }

  get = async (c: Context) => ok(c, await this.service.get(this.id(c), c.get('user').companyId))

  create = async (c: Context) => created(
    c,
    await this.service.create(c.get('user').companyId, salesOrderSchema.parse(await c.req.json()), this.context(c)),
    'Sales order berhasil dibuat',
  )

  update = async (c: Context) => ok(
    c,
    await this.service.update(this.id(c), c.get('user').companyId, salesOrderUpdateSchema.parse(await c.req.json()), this.context(c)),
    'Sales order berhasil diperbarui',
  )

  confirm = async (c: Context) => ok(
    c,
    await this.service.confirm(this.id(c), c.get('user').companyId, this.context(c)),
    'Sales order berhasil dikonfirmasi',
  )

  cancel = async (c: Context) => {
    const input = salesOrderCancelSchema.parse(await c.req.json())
    return ok(c, await this.service.cancel(this.id(c), c.get('user').companyId, input.reason, this.context(c)), 'Sales order dibatalkan')
  }

  convert = async (c: Context) => created(
    c,
    await this.service.convertToInvoice(this.id(c), c.get('user').companyId, salesOrderConversionSchema.parse(await c.req.json()), this.context(c)),
    'Sales invoice Draft berhasil dibuat',
  )

  private id(c: Context) {
    return salesOrderIdSchema.parse(c.req.param('id'))
  }

  private context(c: Context): SalesOrderContext {
    return {
      userId: c.get('user').id,
      requestId: c.get('requestId'),
      ip: requestIp(c),
    }
  }
}
