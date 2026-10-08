import { Hono } from 'hono'
import { MonthEndController } from '../controllers/MonthEndController'
import { requirePermission } from '../middleware/permission.middleware'

const route = new Hono()
const controller = new MonthEndController()

route.get('/export', requirePermission('accounting.close_period'), controller.export)
route.get('/', requirePermission('accounting.close_period'), controller.dashboard)

export default route
