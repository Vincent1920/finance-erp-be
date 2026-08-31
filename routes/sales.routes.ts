import { Hono } from 'hono'

import { SalesOrderController } from '../controllers/SalesOrderController'
import { requirePermission } from '../middleware/permission.middleware'

const route = new Hono()
const orders = new SalesOrderController()

route.get('/orders', requirePermission('sales-orders.view'), orders.list)
route.post('/orders', requirePermission('sales-orders.create'), orders.create)
route.post('/orders/:id/confirm', requirePermission('sales-orders.confirm'), orders.confirm)
route.post('/orders/:id/cancel', requirePermission('sales-orders.cancel'), orders.cancel)
route.post('/orders/:id/convert-to-invoice', requirePermission('sales-invoices.create'), orders.convert)
route.get('/orders/:id', requirePermission('sales-orders.view'), orders.get)
route.put('/orders/:id', requirePermission('sales-orders.update'), orders.update)

export default route
