import { Hono } from 'hono'
import type { AppBindings } from '../types/hono'
import { SettingsController } from '../controllers/SettingsController'
import { requirePermission } from '../middleware/permission.middleware'
import { CoaGovernanceService } from '../services/CoaGovernanceService'
import { systemActor } from '../utils/request-context'
import { ok } from '../utils/response'
import { z } from 'zod'

const route = new Hono<AppBindings>()
const controller = new SettingsController()
const coa = new CoaGovernanceService()
route.get('/coa-control/report', requirePermission('accounts.view'), requirePermission('reports.view'), async c => {
  const date=z.iso.date().parse(c.req.query('date'))
  return ok(c,await coa.groupedReport(c.get('user').companyId,date))
})
route.get('/coa-control', requirePermission('accounts.view'), requirePermission('settings.view'), async c => ok(c,await coa.overview(c.get('user').companyId)))
route.post('/coa-control/requests', requirePermission('accounts.update'), requirePermission('settings.update'), async c => ok(c,await coa.propose(systemActor(c),await c.req.json())))
route.post('/coa-control/requests/:id/review', requirePermission('accounts.update'), requirePermission('settings.update'), async c => {
  const body=z.object({approve:z.boolean(),note:z.string().trim().min(5).max(500)}).parse(await c.req.json())
  return ok(c,await coa.review(systemActor(c),z.coerce.number().int().positive().parse(c.req.param('id')),body.approve,body.note))
})
route.post('/coa-control/template', requirePermission('accounts.create'), requirePermission('settings.update'), async c => {
  const body=z.object({industry:z.enum(['trading','services','manufacturing'])}).parse(await c.req.json())
  return ok(c,await coa.installTemplate(systemActor(c),body.industry))
})

route.get('/', requirePermission('settings.view'), controller.list)
route.put('/', requirePermission('settings.update'), controller.updateMany)
route.get('/accounting-readiness', requirePermission('settings.view'), controller.readiness)
route.get('/account-mappings', requirePermission('settings.view'), controller.accountMappings)
route.put('/account-mappings/:mappingKey', requirePermission('settings.update'), controller.updateAccountMapping)
route.get('/company', requirePermission('settings.view'), controller.company)
route.put('/company', requirePermission('settings.update'), controller.updateCompany)
route.get('/sequences', requirePermission('settings.view'), controller.sequences)
route.put(
  '/sequences/:sequenceKey',
  requirePermission('settings.update'),
  controller.updateSequence,
)
route.get('/:key', requirePermission('settings.view'), controller.get)
route.put('/:key', requirePermission('settings.update'), controller.update)

export default route
