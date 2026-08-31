import { Hono } from 'hono'

import { SalesOrderController } from '../controllers/SalesOrderController'
import { SalesInvoiceController } from '../controllers/SalesInvoiceController'
import { ReceivableController } from '../controllers/ReceivableController'
import { requirePermission } from '../middleware/permission.middleware'

const route = new Hono()
const orders = new SalesOrderController()
const invoices = new SalesInvoiceController()
const receivables = new ReceivableController()

route.get('/receivables/aging', requirePermission('receivables.view'), receivables.aging)

route.get('/invoices', requirePermission('sales-invoices.view'), invoices.list)
route.post('/invoices', requirePermission('sales-invoices.create'), invoices.create)
route.post('/invoices/:id/submit', requirePermission('sales-invoices.submit'), invoices.submit)
route.post('/invoices/:id/approve', requirePermission('sales-invoices.approve'), invoices.approve)
route.post('/invoices/:id/reject', requirePermission('sales-invoices.reject'), invoices.reject)
route.post('/invoices/:id/post', requirePermission('sales-invoices.post'), invoices.post)
route.post('/invoices/:id/reverse', requirePermission('sales-invoices.reverse'), invoices.reverse)
route.post('/invoices/:id/cancel', requirePermission('sales-invoices.cancel'), invoices.cancel)
route.get('/invoices/:id', requirePermission('sales-invoices.view'), invoices.get)
route.put('/invoices/:id', requirePermission('sales-invoices.update'), invoices.update)

route.get('/orders', requirePermission('sales-orders.view'), orders.list)
route.post('/orders', requirePermission('sales-orders.create'), orders.create)
route.post('/orders/:id/confirm', requirePermission('sales-orders.confirm'), orders.confirm)
route.post('/orders/:id/cancel', requirePermission('sales-orders.cancel'), orders.cancel)
route.post('/orders/:id/convert-to-invoice', requirePermission('sales-invoices.create'), orders.convert)
route.get('/orders/:id', requirePermission('sales-orders.view'), orders.get)
route.put('/orders/:id', requirePermission('sales-orders.update'), orders.update)

export default route
