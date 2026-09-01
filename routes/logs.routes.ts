import { Hono } from 'hono'
import { LogController } from '../controllers/LogController'
import { requirePermission } from '../middleware/permission.middleware'

const auditLogs = new Hono(),
  errorLogs = new Hono(),
  controller = new LogController()
auditLogs.get('/', requirePermission('audit-logs.view'), controller.auditList)
auditLogs.get('/:id', requirePermission('audit-logs.view'), controller.auditGet)
errorLogs.get('/', requirePermission('error-logs.view'), controller.errorList)
errorLogs.get('/:id', requirePermission('error-logs.view'), controller.errorGet)
export { auditLogs, errorLogs }
