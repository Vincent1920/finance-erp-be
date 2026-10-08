import { Hono } from 'hono'
import { z } from 'zod'
import type { Context } from 'hono'
import { requirePermission } from '../middleware/permission.middleware'
import { EquityService } from '../services/EquityService'
import { created, ok } from '../utils/response'
import { requestIp } from '../utils/request-context'
import { isoDateSchema, positiveIdSchema } from '../validators/common.validator'
import {
  equityRangeSchema,
  equityTransactionSchema,
  holdingCreateSchema,
  shareholderSchema,
  shareholderUpdateSchema,
} from '../validators/equity.validator'

const route = new Hono(),
  service = new EquityService()
const context = (c: Context) => ({
  userId: c.get('user').id,
  requestId: c.get('requestId'),
  ip: requestIp(c),
})
const company = (c: Context) => c.get('user').companyId
route.get('/shareholders', requirePermission('accounting.view'), async (c) =>
  ok(c, await service.shareholders(company(c), isoDateSchema.parse(c.req.query('as_of_date')))),
)
route.post('/shareholders', requirePermission('accounting.create'), async (c) =>
  created(
    c,
    await service.createShareholder(
      company(c),
      shareholderSchema.parse(await c.req.json()),
      context(c),
    ),
  ),
)
route.put('/shareholders/:id', requirePermission('accounting.update'), async (c) =>
  ok(
    c,
    await service.updateShareholder(
      company(c),
      positiveIdSchema.parse(c.req.param('id')),
      shareholderUpdateSchema.parse(await c.req.json()),
      context(c),
    ),
  ),
)
route.get('/shareholders/:id/history', requirePermission('accounting.view'), async (c) =>
  ok(c, await service.history(company(c), positiveIdSchema.parse(c.req.param('id')))),
)
route.post('/shareholders/:id/holdings', requirePermission('accounting.update'), async (c) =>
  created(
    c,
    await service.addHolding(
      company(c),
      positiveIdSchema.parse(c.req.param('id')),
      holdingCreateSchema.parse(await c.req.json()),
      context(c),
    ),
  ),
)
route.get('/journal-options', requirePermission('accounting.view'), async (c) =>
  ok(c, await service.journalOptions(company(c))),
)
route.get('/transactions', requirePermission('accounting.view'), async (c) => {
  const q = equityRangeSchema.parse(c.req.query())
  return ok(c, await service.transactions(company(c), q.date_from, q.date_to))
})
route.post('/transactions', requirePermission('accounting.create'), async (c) =>
  created(
    c,
    await service.createTransaction(
      company(c),
      equityTransactionSchema.parse(await c.req.json()),
      context(c),
    ),
  ),
)
route.post('/transactions/:id/cancel', requirePermission('accounting.delete'), async (c) => {
  const input = z.object({ reason: z.string().trim().min(3).max(1000) }).parse(await c.req.json())
  return ok(
    c,
    await service.cancel(
      company(c),
      positiveIdSchema.parse(c.req.param('id')),
      input.reason,
      context(c),
    ),
  )
})
route.get('/report', requirePermission('reports.view'), async (c) => {
  const q = equityRangeSchema.parse(c.req.query())
  return ok(c, await service.report(company(c), q.date_from, q.date_to))
})
export default route
