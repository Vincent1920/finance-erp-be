import type { Context } from 'hono'
import { LogRepository } from '../repositories/LogRepository'
import { NotFoundError } from '../utils/AppError'
import { ok, paginated } from '../utils/response'

export class LogController {
  constructor(private readonly logs = new LogRepository()) {}
  auditList = async (c: Context) => {
    const result = await this.logs.auditList(c.get('user').companyId, c.req.query())
    return paginated(c, result.rows, result)
  }
  auditGet = async (c: Context) => {
    const row = await this.logs.auditFind(Number(c.req.param('id')), c.get('user').companyId)
    if (!row) throw new NotFoundError('Audit log tidak ditemukan')
    return ok(c, row)
  }
  errorList = async (c: Context) => {
    const result = await this.logs.errorList(c.get('user').companyId, c.req.query())
    return paginated(c, result.rows, result)
  }
  errorGet = async (c: Context) => {
    const row = await this.logs.errorFind(Number(c.req.param('id')), c.get('user').companyId)
    if (!row) throw new NotFoundError('Error log tidak ditemukan')
    return ok(c, row)
  }
}
