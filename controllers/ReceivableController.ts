import type { Context } from 'hono'
import { ReportingService } from '../services/ReportingService'
import { ok } from '../utils/response'
import { asOfQuerySchema } from '../validators/report.validator'

export class ReceivableController {
  constructor(private service = new ReportingService()) {}
  aging = async (c: Context) => {
    const query = asOfQuerySchema.parse(c.req.query())
    return ok(c, await this.service.aging(c.get('user').companyId, 'receivable', query.as_of_date))
  }
}
