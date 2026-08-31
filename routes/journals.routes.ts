import { Hono } from 'hono'

import { JournalController } from '../controllers/JournalController'
import { requirePermission } from '../middleware/permission.middleware'

const route = new Hono()
const controller = new JournalController()

route.get('/', requirePermission('accounting.view'), controller.list)
route.post('/', requirePermission('accounting.create'), controller.create)
route.post('/:id/submit', requirePermission('accounting.submit'), controller.submit)
route.post('/:id/approve', requirePermission('accounting.approve'), controller.approve)
route.post('/:id/reject', requirePermission('accounting.reject'), controller.reject)
route.post('/:id/post', requirePermission('accounting.post'), controller.post)
route.post('/:id/reverse', requirePermission('accounting.reverse'), controller.reverse)
route.get('/:id', requirePermission('accounting.view'), controller.get)
route.put('/:id', requirePermission('accounting.update'), controller.update)
route.delete('/:id', requirePermission('accounting.delete'), controller.remove)

export default route
