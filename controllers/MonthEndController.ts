import type { Context } from 'hono'
import { z } from 'zod'
import { MonthEndService } from '../services/MonthEndService'
import { ok } from '../utils/response'

const querySchema = z.object({ as_of_date: z.iso.date() })

export class MonthEndController {
  constructor(private service = new MonthEndService()) {}
  dashboard = async (c: Context) => {
    const query = querySchema.parse(c.req.query())
    return ok(c, await this.service.dashboard(c.get('user').companyId, query.as_of_date))
  }
}
