import type { Context } from 'hono'

import { ImportService, type ImportActor } from '../services/ImportService'
import { ValidationError } from '../utils/AppError'
import { created, ok, paginated } from '../utils/response'
import { requestIp } from '../utils/request-context'
import {
  importConfirmSchema,
  importHistoryQuerySchema,
  importIdSchema,
  importRowsQuerySchema,
  importTypeSchema,
  templateFormatSchema,
} from '../validators/import.validator'

export class ImportController {
  constructor(private readonly service = new ImportService()) {}

  config = async (c: Context) => ok(c, await this.service.config(this.actor(c)))

  list = async (c: Context) => {
    const query = importHistoryQuerySchema.parse(c.req.query())
    const result = await this.service.list(this.actor(c), query)
    return paginated(c, result.rows, result)
  }

  get = async (c: Context) =>
    ok(c, await this.service.get(this.actor(c), importIdSchema.parse(c.req.param('id'))))

  rows = async (c: Context) => {
    const query = importRowsQuerySchema.parse(c.req.query())
    const result = await this.service.rows(
      this.actor(c),
      importIdSchema.parse(c.req.param('id')),
      query,
    )
    return paginated(c, result.rows, result)
  }

  preview = async (c: Context) => {
    const body = await c.req.parseBody()
    const type = importTypeSchema.parse(body.import_type)
    const file = body.file
    if (
      !file ||
      typeof file === 'string' ||
      typeof file.name !== 'string' ||
      typeof file.arrayBuffer !== 'function'
    ) {
      throw new ValidationError('File CSV atau XLSX wajib dipilih')
    }
    const result = await this.service.preview(this.actor(c), type, file)
    return created(c, result, 'File berhasil divalidasi; belum ada data bisnis yang diimpor')
  }

  confirm = async (c: Context) => {
    const input = importConfirmSchema.parse(await c.req.json())
    return ok(
      c,
      await this.service.confirm(
        this.actor(c),
        importIdSchema.parse(c.req.param('id')),
        input,
      ),
      'Import berhasil dikonfirmasi',
    )
  }

  cancel = async (c: Context) =>
    ok(
      c,
      await this.service.cancel(this.actor(c), importIdSchema.parse(c.req.param('id'))),
      'Import dibatalkan dan payload sementara dihapus',
    )

  template = async (c: Context) => {
    const result = await this.service.template(
      this.actor(c),
      importTypeSchema.parse(c.req.param('type')),
      templateFormatSchema.parse(c.req.query('format')),
    )
    return this.download(c, result)
  }

  errors = async (c: Context) => {
    const result = await this.service.errorReport(
      this.actor(c),
      importIdSchema.parse(c.req.param('id')),
      templateFormatSchema.parse(c.req.query('format')),
    )
    return this.download(c, result)
  }

  private actor(c: Context): ImportActor {
    const user = c.get('user')
    return {
      ...user,
      id: user.id,
      companyId: user.companyId,
      requestId: c.get('requestId'),
      ip: requestIp(c),
    }
  }

  private download(
    c: Context,
    result: { content: Buffer; contentType: string; filename: string },
  ) {
    c.header('Content-Type', result.contentType)
    c.header('Content-Disposition', `attachment; filename="${result.filename}"`)
    c.header('Cache-Control', 'no-store')
    c.header('X-Content-Type-Options', 'nosniff')
    return c.body(new Uint8Array(result.content))
  }
}
