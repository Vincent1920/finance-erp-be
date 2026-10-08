import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { PayrollController } from '../controllers/PayrollController'
import { requirePermission } from '../middleware/permission.middleware'
const route = new Hono(),
  c = new PayrollController()
route.get('/components',requirePermission('payroll.view'),c.componentList)
route.post('/components',requirePermission('payroll.manage'),c.componentCreate)
route.put('/components/:id',requirePermission('payroll.manage'),c.componentUpdate)
route.get('/', requirePermission('payroll.view'), c.overview)
route.post('/employees', requirePermission('payroll.manage'), c.employeeCreate)
route.put('/employees/:id', requirePermission('payroll.manage'), c.employeeUpdate)
route.patch('/employees/:id/status', requirePermission('payroll.manage'), c.employeeStatus)
route.get(
  '/employees/:id/compensation-history',
  requirePermission('payroll.view'),
  c.employeeCompensationHistory,
)
route.post('/runs', requirePermission('payroll.create'), c.runCreate)
route.get('/runs/:id', requirePermission('payroll.view'), c.detail)
route.put('/runs/:id/entries/:entryId', requirePermission('payroll.update'), c.entryUpdate)
route.post('/runs/:id/calculate', requirePermission('payroll.calculate'), c.calculate)
route.post(
  '/runs/:id/policy-simulation',
  requirePermission('payroll.view'),
  c.policySimulation,
)
route.post('/runs/:id/unlock', requirePermission('payroll.manage'), c.unlock)
route.post('/runs/:id/reopen', requirePermission('payroll.update'), c.reopen)
route.post('/runs/:id/approve', requirePermission('payroll.approve'), c.approve)
route.post('/runs/:id/post', requirePermission('payroll.post'), c.post)
route.post('/runs/:id/pay', requirePermission('payroll.pay'), c.pay)
route.post('/runs/:id/lock', requirePermission('payroll.lock'), c.lock)
route.get('/import-template', requirePermission('payroll.view'), c.importTemplate)
route.get('/runs/:id/export/:kind', requirePermission('payroll.view'), c.export)
route.post(
  '/runs/:id/import/preview',
  requirePermission('payroll.update'),
  bodyLimit({
    maxSize: 6 * 1024 * 1024,
    onError: (ctx) =>
      ctx.json({ success: false, message: 'Ukuran upload melebihi batas 5 MB' }, 413),
  }),
  c.importPreview,
)
route.post(
  '/runs/:id/import',
  requirePermission('payroll.update'),
  bodyLimit({
    maxSize: 6 * 1024 * 1024,
    onError: (ctx) =>
      ctx.json({ success: false, message: 'Ukuran upload melebihi batas 5 MB' }, 413),
  }),
  c.importApply,
)
route.put('/policy', requirePermission('payroll.manage'), c.policy)
export default route
