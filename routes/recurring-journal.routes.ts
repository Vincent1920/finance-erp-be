import { Hono } from 'hono'
import { RecurringJournalController } from '../controllers/RecurringJournalController'
import { requirePermission } from '../middleware/permission.middleware'

const route = new Hono()
const controller = new RecurringJournalController()

route.get('/', requirePermission('accounting.view'), controller.overview)
route.post('/', requirePermission('accounting.create'), controller.create)
route.post('/generate-due', requirePermission('accounting.create'), controller.generateDue)
route.put('/:id', requirePermission('accounting.update'), controller.update)
route.patch('/:id/active', requirePermission('accounting.update'), controller.setActive)
route.post('/:id/generate', requirePermission('accounting.create'), controller.generate)

export default route
