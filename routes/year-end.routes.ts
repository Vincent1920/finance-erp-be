import { Hono } from 'hono'
import { YearEndClosingController } from '../controllers/YearEndClosingController'
import { requirePermission } from '../middleware/permission.middleware'

const route = new Hono()
const controller = new YearEndClosingController()

route.get('/', requirePermission('accounting.close_period'), controller.overview)
route.post('/preview', requirePermission('accounting.close_period'), controller.preview)
route.post('/validate', requirePermission('accounting.close_period'), controller.validate)
route.post('/:id/post', requirePermission('accounting.close_period'), controller.post)
route.post('/:id/reverse', requirePermission('accounting.reopen_period'), controller.reverse)

export default route
