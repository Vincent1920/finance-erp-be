import { Hono } from 'hono'
import type { Context } from 'hono'
import { requirePermission } from '../middleware/permission.middleware'
import { OpeningBalanceService } from '../services/OpeningBalanceService'
import { positiveIdSchema } from '../validators/common.validator'
import { ok } from '../utils/response'
import { requestIp } from '../utils/request-context'

const route = new Hono(),
  service = new OpeningBalanceService()
const company = (c: Context) => c.get('user').companyId
const context = (c: Context) => ({
  userId: c.get('user').id,
  requestId: c.get('requestId'),
  ip: requestIp(c),
})
route.get('/', requirePermission('accounting.view'), async (c) =>
  ok(c, await service.list(company(c))),
)
route.get('/:id', requirePermission('accounting.view'), async (c) =>
  ok(c, await service.detail(company(c), positiveIdSchema.parse(c.req.param('id')))),
)
route.post('/:id/prepare-journal', requirePermission('accounting.create'), async (c) =>
  ok(
    c,
    await service.prepareJournal(company(c), positiveIdSchema.parse(c.req.param('id')), context(c)),
  ),
)
export default route
