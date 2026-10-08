import { Hono } from 'hono'
import { ApprovalCenterController } from '../controllers/ApprovalCenterController'
import { requirePermission } from '../middleware/permission.middleware'

const route = new Hono()
const controller = new ApprovalCenterController()

route.get('/', requirePermission('approvals.view'), controller.queue)

export default route
