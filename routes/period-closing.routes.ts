import { Hono } from 'hono'
import { PeriodClosingController } from '../controllers/PeriodClosingController'
import { requirePermission } from '../middleware/permission.middleware'

const route = new Hono()
const controller = new PeriodClosingController()

route.get('/', requirePermission('accounting.close_period'), controller.overview)
route.post('/validate', requirePermission('accounting.close_period'), controller.validate)
route.post('/:id/complete', requirePermission('accounting.close_period'), controller.complete)
route.post('/:id/reopen', requirePermission('accounting.reopen_period'), controller.reopen)
route.post('/reopen-requests/:id/approve', requirePermission('accounting.close_period'), controller.approveReopen)
route.post('/reopen-requests/:id/reject', requirePermission('accounting.close_period'), controller.rejectReopen)

export default route
