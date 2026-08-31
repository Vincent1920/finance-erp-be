import type { Context } from 'hono'
import type { ZodObject, ZodRawShape } from 'zod'
import { EntityService } from '../services/EntityService'
import type { EntityTable } from '../repositories/EntityRepository'
import { created, ok, paginated } from '../utils/response'

const requestContext = (c: Context) => ({
  userId: c.get('user').id,
  requestId: c.get('requestId'),
  ip:
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-real-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim(),
})

export class EntityController {
  private service: EntityService
  constructor(
    table: EntityTable,
    private schema: ZodObject<ZodRawShape>,
  ) {
    this.service = new EntityService(table)
  }
  list = async (c: Context) => {
    const user = c.get('user'),
      result = await this.service.list(user.companyId, c.req.query())
    return paginated(c, result.rows, result)
  }
  get = async (c: Context) =>
    ok(c, await this.service.get(Number(c.req.param('id')), c.get('user').companyId))
  create = async (c: Context) =>
    created(
      c,
      await this.service.create(
        c.get('user').companyId,
        this.schema.parse(await c.req.json()) as Record<string, unknown>,
        requestContext(c),
      ),
    )
  update = async (c: Context) =>
    ok(
      c,
      await this.service.update(
        Number(c.req.param('id')),
        c.get('user').companyId,
        this.schema.partial().parse(await c.req.json()) as Record<string, unknown>,
        requestContext(c),
      ),
      'Data berhasil diperbarui',
    )
  remove = async (c: Context) => {
    const result = await this.service.remove(
      Number(c.req.param('id')),
      c.get('user').companyId,
      requestContext(c),
    )
    return ok(c, null, result === 'deactivated' ? 'Data berhasil dinonaktifkan' : 'Data berhasil dihapus')
  }
}
