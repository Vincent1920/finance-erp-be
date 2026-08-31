import { Hono } from 'hono'
import { SettingsController } from '../controllers/SettingsController'
import { requirePermission } from '../middleware/permission.middleware'

const route = new Hono()
const controller = new SettingsController()

route.get('/', requirePermission('settings.view'), controller.list)
route.put('/', requirePermission('settings.update'), controller.updateMany)
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
