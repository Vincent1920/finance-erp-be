import { Hono } from 'hono'
import { JournalController } from '../controllers/JournalController'
import { requirePermission } from '../middleware/permission.middleware'
const route = new Hono(),
  controller = new JournalController()
route.post('/', requirePermission('accounting.create'), controller.create)
route.post('/:id/post', requirePermission('accounting.post'), controller.post)
export default route
