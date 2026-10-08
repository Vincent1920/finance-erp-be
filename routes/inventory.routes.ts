import { Hono } from 'hono'

import { InventoryController } from '../controllers/InventoryController'
import { requirePermission } from '../middleware/permission.middleware'

const route = new Hono()
const controller = new InventoryController()

route.get('/stock', requirePermission('inventory.view'), controller.overview)
route.get('/valuation', requirePermission('inventory.view'), controller.valuation)
route.get('/card', requirePermission('inventory.view'), controller.card)
route.get('/summary', requirePermission('inventory.view'), controller.summary)

export default route
