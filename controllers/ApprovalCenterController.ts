import type { Context } from 'hono'
import { ApprovalCenterService } from '../services/ApprovalCenterService'
import { ok } from '../utils/response'

export class ApprovalCenterController {
  constructor(private service = new ApprovalCenterService()) {}

  queue = async (c: Context) =>
    ok(c, await this.service.queue(c.get('user').companyId, {
      type: c.req.query('type'),
      search: c.req.query('search'),
    }))
}
