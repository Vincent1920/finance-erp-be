import type { Context } from 'hono'
import { ReportingService } from '../services/ReportingService'
import { ok } from '../utils/response'
export class ReportController {
  constructor(private service = new ReportingService()) {}
  trialBalance = async (c: Context) =>
    ok(c, await this.service.trialBalance(c.get('user').companyId))
}
