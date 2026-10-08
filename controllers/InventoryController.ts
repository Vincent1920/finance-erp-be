import type { Context } from 'hono'

import { InventoryService } from '../services/InventoryService'
import { ok, paginated } from '../utils/response'
import { isoDateSchema } from '../validators/common.validator'
import {
  inventoryCardQuerySchema,
  stockOverviewQuerySchema,
} from '../validators/inventory.validator'

export class InventoryController {
  summary = async (c:Context) => ok(c, await this.service.summary(c.get('user').companyId,inventoryCardQuerySchema.parse(c.req.query())))
  valuation = async (c: Context) => ok(c, await this.service.valuation(c.get('user').companyId, isoDateSchema.parse(c.req.query('as_of_date'))))
  constructor(private service = new InventoryService()) {}

  overview = async (c: Context) => {
    const query = stockOverviewQuerySchema.parse(c.req.query())
    const result = await this.service.overview(c.get('user').companyId, query)
    return paginated(c, result.rows, result)
  }

  card = async (c: Context) => {
    const query = inventoryCardQuerySchema.parse(c.req.query())
    const result = await this.service.card(c.get('user').companyId, query)
    return c.json({
      success: true,
      message: 'Kartu stok berhasil diambil',
      data: result.rows,
      opening: result.opening,
      meta: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: Math.ceil(result.total / result.limit),
      },
    })
  }
}
