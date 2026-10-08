import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { AccountingScheduleController } from '../controllers/AccountingScheduleController'
import { requirePermission } from '../middleware/permission.middleware'

const route = new Hono(),
  controller = new AccountingScheduleController()
route.get('/', requirePermission('accounting.view'), controller.overview)
route.get('/templates', requirePermission('accounting.view'), controller.templates)
route.get('/alerts', requirePermission('accounting.view'), controller.alerts)
route.get(
  '/entries/:id/actual-sources',
  requirePermission('accounting.view'),
  controller.actualSources,
)
route.post('/entries/:id/adjustment', requirePermission('accounting.update'), controller.adjustment)
route.post('/', requirePermission('accounting.create'), controller.create)
route.post('/generate-due', requirePermission('accounting.create'), controller.generateDue)
route.post(
  '/process-reversals',
  requirePermission('accounting.create'),
  controller.processReversals,
)
route.post('/entries/:id/generate', requirePermission('accounting.create'), controller.generate)
route.post('/entries/:id/reverse', requirePermission('accounting.create'), controller.reverse)
route.put('/entries/:id/reconcile', requirePermission('accounting.update'), controller.reconcile)
route.post(
  '/entries/:id/attachments',
  requirePermission('accounting.update'),
  bodyLimit({ maxSize: 11 * 1024 * 1024 }),
  controller.uploadAttachment,
)
route.get(
  '/attachments/:id/download',
  requirePermission('accounting.view'),
  controller.downloadAttachment,
)
route.delete(
  '/attachments/:id',
  requirePermission('accounting.update'),
  controller.removeAttachment,
)
export default route
