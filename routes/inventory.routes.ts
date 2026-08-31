import { Hono } from 'hono'

import { InventoryController } from '../controllers/InventoryController'
import { requirePermission } from '../middleware/permission.middleware'

const route = new Hono()
const controller = new InventoryController()

route.get('/stock', requirePermission('inventory.view'), controller.overview)
route.get('/card', requirePermission('inventory.view'), controller.card)

export default route
