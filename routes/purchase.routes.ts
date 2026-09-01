import { Hono } from 'hono'
import { PurchaseOrderController } from '../controllers/PurchaseOrderController'
import { GoodsReceiptController } from '../controllers/GoodsReceiptController'
import { requirePermission } from '../middleware/permission.middleware'
const route = new Hono(),
  orders = new PurchaseOrderController(),
  receipts = new GoodsReceiptController()

route.get('/receipts', requirePermission('goods-receipts.view'), receipts.list)
route.post('/receipts', requirePermission('goods-receipts.create'), receipts.create)
route.post('/receipts/:id/post', requirePermission('goods-receipts.post'), receipts.post)
route.post('/receipts/:id/cancel', requirePermission('goods-receipts.cancel'), receipts.cancel)
route.post('/receipts/:id/reverse', requirePermission('goods-receipts.reverse'), receipts.reverse)
route.get('/receipts/:id', requirePermission('goods-receipts.view'), receipts.get)
route.get('/orders', requirePermission('purchase-orders.view'), orders.list)
route.post('/orders', requirePermission('purchase-orders.create'), orders.create)
route.post('/orders/:id/confirm', requirePermission('purchase-orders.confirm'), orders.confirm)
route.post('/orders/:id/cancel', requirePermission('purchase-orders.cancel'), orders.cancel)
route.get('/orders/:id', requirePermission('purchase-orders.view'), orders.get)
route.put('/orders/:id', requirePermission('purchase-orders.update'), orders.update)
export default route
