import { Hono } from 'hono'

import { DashboardController } from '../controllers/DashboardController'
import { SearchController } from '../controllers/SearchController'
import { authMiddleware } from '../middleware/auth.middleware'
import { requirePermission } from '../middleware/permission.middleware'
import {
  accountSchema,
  accountingPeriodSchema,
  bankAccountSchema,
  costCenterSchema,
  customerSchema,
  itemSchema,
  projectSchema,
  supplierSchema,
  taxCodeSchema,
  unitSchema,
  warehouseSchema,
} from '../validators/entity.validator'

import auth from './auth.routes'
import { entityRoutes } from './entity.routes'
import inventory from './inventory.routes'
import imports from './imports.routes'
import journals from './journals.routes'
import permissions from './permissions.routes'
import reports from './reports.routes'
import roles from './roles.routes'
import sales from './sales.routes'
import purchases from './purchase.routes'
import settings from './settings.routes'
import users from './users.routes'
import { auditLogs, errorLogs } from './logs.routes'

const route = new Hono()
const dashboard = new DashboardController()
const search = new SearchController()

route.get('/health', dashboard.health)
route.route('/auth', auth)

route.use('/dashboard/*', authMiddleware)
route.get('/dashboard/summary', requirePermission('dashboard.view'), dashboard.summary)
route.use('/transactions/*', authMiddleware)
route.get('/transactions', requirePermission('transaction-browser.view'), search.transactions)
route.use('/global-search/*', authMiddleware)
route.get('/global-search', requirePermission('global-search.view'), search.global)

route.use('/accounting-periods/*', authMiddleware)
route.route(
  '/accounting-periods',
  entityRoutes('accounting_periods', 'accounting-periods', accountingPeriodSchema),
)

route.use('/accounts/*', authMiddleware)
route.route('/accounts', entityRoutes('accounts', 'accounts', accountSchema))

route.use('/customers/*', authMiddleware)
route.route('/customers', entityRoutes('customers', 'customers', customerSchema))

route.use('/suppliers/*', authMiddleware)
route.route('/suppliers', entityRoutes('suppliers', 'suppliers', supplierSchema))

route.use('/items/*', authMiddleware)
route.route('/items', entityRoutes('items', 'items', itemSchema))

route.use('/warehouses/*', authMiddleware)
route.route('/warehouses', entityRoutes('warehouses', 'warehouses', warehouseSchema))

route.use('/units/*', authMiddleware)
route.route('/units', entityRoutes('units', 'units', unitSchema))

route.use('/tax-codes/*', authMiddleware)
route.route('/tax-codes', entityRoutes('tax_codes', 'tax-codes', taxCodeSchema))

route.use('/cost-centers/*', authMiddleware)
route.route('/cost-centers', entityRoutes('cost_centers', 'cost-centers', costCenterSchema))

route.use('/projects/*', authMiddleware)
route.route('/projects', entityRoutes('projects', 'projects', projectSchema))

route.use('/bank-accounts/*', authMiddleware)
route.route('/bank-accounts', entityRoutes('bank_accounts', 'bank-accounts', bankAccountSchema))

route.use('/journals/*', authMiddleware)
route.route('/journals', journals)

route.use('/inventory/*', authMiddleware)
route.route('/inventory', inventory)

route.use('/imports/*', authMiddleware)
route.route('/imports', imports)

route.use('/sales/*', authMiddleware)
route.use('/purchases/*', authMiddleware)
route.route('/sales', sales)
route.route('/purchases', purchases)

route.use('/reports/*', authMiddleware)
route.route('/reports', reports)

route.use('/users/*', authMiddleware)
route.route('/users', users)

route.use('/roles/*', authMiddleware)
route.route('/roles', roles)

route.use('/permissions/*', authMiddleware)
route.route('/permissions', permissions)

route.use('/settings/*', authMiddleware)
route.route('/settings', settings)

route.use('/audit-logs/*', authMiddleware)
route.route('/audit-logs', auditLogs)
route.use('/error-logs/*', authMiddleware)
route.route('/error-logs', errorLogs)

export default route
