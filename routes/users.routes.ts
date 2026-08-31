import { Hono } from 'hono'
import { SystemUserController } from '../controllers/SystemUserController'
import { requirePermission } from '../middleware/permission.middleware'

const route = new Hono()
const controller = new SystemUserController()

route.get('/', requirePermission('users.view'), controller.list)
route.post('/', requirePermission('users.create'), controller.create)
route.get('/:id', requirePermission('users.view'), controller.get)
route.put('/:id', requirePermission('users.update'), controller.update)
route.patch('/:id/status', requirePermission('users.update'), controller.status)
route.post('/:id/activate', requirePermission('users.activate'), controller.activate)
route.post('/:id/deactivate', requirePermission('users.deactivate'), controller.deactivate)
route.post('/:id/lock', requirePermission('users.lock'), controller.lock)
route.post('/:id/reset-password', requirePermission('users.reset_password'), controller.resetPassword)
route.put('/:id/roles', requirePermission('users.update'), controller.roles)
route.delete('/:id', requirePermission('users.delete'), controller.remove)

export default route
