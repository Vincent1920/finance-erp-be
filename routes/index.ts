import { Hono } from 'hono'

import { DashboardController } from '../controllers/DashboardController'
import { authMiddleware } from '../middleware/auth.middleware'
import {
  accountSchema,
  customerSchema,
  itemSchema,
  supplierSchema,
} from '../validators/entity.validator'

import auth from './auth.routes'
import { entityRoutes } from './entity.routes'
import journals from './journals.routes'
import reports from './reports.routes'

const route = new Hono()
const dashboard = new DashboardController()

route.get('/health', dashboard.health)
route.route('/auth', auth)

route.use('/dashboard/*', authMiddleware)
route.get('/dashboard/summary', dashboard.summary)

route.use('/accounts/*', authMiddleware)
route.route('/accounts', entityRoutes('accounts', 'accounts', accountSchema))

route.use('/customers/*', authMiddleware)
route.route('/customers', entityRoutes('customers', 'customers', customerSchema))

route.use('/suppliers/*', authMiddleware)
route.route('/suppliers', entityRoutes('suppliers', 'suppliers', supplierSchema))

route.use('/items/*', authMiddleware)
route.route('/items', entityRoutes('items', 'items', itemSchema))

route.use('/journals/*', authMiddleware)
route.route('/journals', journals)

route.use('/reports/*', authMiddleware)
route.route('/reports', reports)

export default route
