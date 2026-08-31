import { Hono } from 'hono'
import { RoleController } from '../controllers/RoleController'
import { requirePermission } from '../middleware/permission.middleware'

const route = new Hono()
const controller = new RoleController()

route.get('/', requirePermission('roles.view'), controller.list)
route.post('/', requirePermission('roles.create'), controller.create)
route.get('/:id', requirePermission('roles.view'), controller.get)
route.put('/:id', requirePermission('roles.update'), controller.update)
route.put('/:id/permissions', requirePermission('roles.update'), controller.permissions)
route.delete('/:id', requirePermission('roles.delete'), controller.remove)

export default route
