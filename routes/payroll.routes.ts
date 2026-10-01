import { Hono } from 'hono'
import { PayrollController } from '../controllers/PayrollController'
import { requirePermission } from '../middleware/permission.middleware'
const route=new Hono(), c=new PayrollController()
route.get('/',requirePermission('payroll.view'),c.overview)
route.post('/employees',requirePermission('payroll.manage'),c.employeeCreate)
route.put('/employees/:id',requirePermission('payroll.manage'),c.employeeUpdate)
route.post('/runs',requirePermission('payroll.create'),c.runCreate)
route.get('/runs/:id',requirePermission('payroll.view'),c.detail)
route.put('/runs/:id/entries/:entryId',requirePermission('payroll.update'),c.entryUpdate)
route.post('/runs/:id/calculate',requirePermission('payroll.calculate'),c.calculate)
route.post('/runs/:id/reopen',requirePermission('payroll.update'),c.reopen)
route.post('/runs/:id/approve',requirePermission('payroll.approve'),c.approve)
route.post('/runs/:id/post',requirePermission('payroll.post'),c.post)
route.post('/runs/:id/pay',requirePermission('payroll.pay'),c.pay)
route.post('/runs/:id/lock',requirePermission('payroll.lock'),c.lock)
route.put('/policy',requirePermission('payroll.manage'),c.policy)
export default route
