import { Hono } from 'hono'

import { ReportController } from '../controllers/ReportController'
import { requirePermission } from '../middleware/permission.middleware'

const route = new Hono()
const controller = new ReportController()
const canView = requirePermission('reports.view')

route.get('/general-ledger', canView, controller.generalLedger)
route.get('/trial-balance', canView, controller.trialBalance)
route.get('/profit-loss', canView, controller.profitLoss)
route.get('/balance-sheet', canView, controller.balanceSheet)
route.get('/cash-flow', canView, controller.cashFlow)
route.get('/receivable-aging', canView, controller.receivableAging)
route.get('/payable-aging', canView, controller.payableAging)
route.get('/inventory', canView, controller.inventory)
route.get('/subledger-reconciliation', canView, controller.subledger)
route.get('/budget-vs-actual', canView, controller.budgetVsActual)

export default route
