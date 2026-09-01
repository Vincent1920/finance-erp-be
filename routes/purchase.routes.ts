import { Hono } from 'hono'
import { PurchaseOrderController } from '../controllers/PurchaseOrderController'
import { GoodsReceiptController } from '../controllers/GoodsReceiptController'
import { PurchaseInvoiceController } from '../controllers/PurchaseInvoiceController'
import { requirePermission } from '../middleware/permission.middleware'
const route = new Hono(),
  orders = new PurchaseOrderController(),
  receipts = new GoodsReceiptController(),
  invoices = new PurchaseInvoiceController()

route.get('/invoices', requirePermission('purchase-invoices.view'), invoices.list)
route.post('/invoices', requirePermission('purchase-invoices.create'), invoices.create)
route.post('/invoices/:id/submit', requirePermission('purchase-invoices.submit'), invoices.submit)
route.post(
  '/invoices/:id/approve',
  requirePermission('purchase-invoices.approve'),
  invoices.approve,
)
route.post('/invoices/:id/reject', requirePermission('purchase-invoices.reject'), invoices.reject)
route.post('/invoices/:id/post', requirePermission('purchase-invoices.post'), invoices.post)
route.post(
  '/invoices/:id/reverse',
  requirePermission('purchase-invoices.reverse'),
  invoices.reverse,
)
route.post('/invoices/:id/cancel', requirePermission('purchase-invoices.cancel'), invoices.cancel)
route.get('/invoices/:id', requirePermission('purchase-invoices.view'), invoices.get)
route.put('/invoices/:id', requirePermission('purchase-invoices.update'), invoices.update)

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
