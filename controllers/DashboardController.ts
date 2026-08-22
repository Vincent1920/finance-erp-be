import type { Context } from 'hono'
import { DashboardService } from '../services/DashboardService'
import { ok } from '../utils/response'
export class DashboardController {
  constructor(private service = new DashboardService()) {}
  health = async (c: Context) => c.json(await this.service.health())
  summary = async (c: Context) => ok(c, await this.service.summary(c.get('user').companyId))
}
