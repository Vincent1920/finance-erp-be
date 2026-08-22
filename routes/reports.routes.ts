import { Hono } from 'hono'
import { ReportController } from '../controllers/ReportController'
import { requirePermission } from '../middleware/permission.middleware'
const route = new Hono(),
  controller = new ReportController()
route.get('/trial-balance', requirePermission('reports.view'), controller.trialBalance)
export default route
