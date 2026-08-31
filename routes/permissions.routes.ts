import { Hono } from 'hono'
import { RoleController } from '../controllers/RoleController'
import { requirePermission } from '../middleware/permission.middleware'

const route = new Hono()
const controller = new RoleController()

route.get('/', requirePermission('roles.view'), controller.permissionList)
route.get('/:id', requirePermission('roles.view'), controller.permissionGet)
route.post('/', requirePermission('roles.create'), controller.permissionCreate)
route.put('/:id', requirePermission('roles.update'), controller.permissionUpdate)
route.delete('/:id', requirePermission('roles.delete'), controller.permissionRemove)

export default route
