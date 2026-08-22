import type { Context } from 'hono'
import type { ZodObject, ZodRawShape } from 'zod'
import { EntityService } from '../services/EntityService'
import type { EntityTable } from '../repositories/EntityRepository'
import { created, ok, paginated } from '../utils/response'
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
      ),
    )
  update = async (c: Context) =>
    ok(
      c,
      await this.service.update(
        Number(c.req.param('id')),
        c.get('user').companyId,
        this.schema.partial().parse(await c.req.json()) as Record<string, unknown>,
      ),
      'Data berhasil diperbarui',
    )
  remove = async (c: Context) => {
    await this.service.remove(Number(c.req.param('id')), c.get('user').companyId)
    return ok(c, null, 'Data berhasil dihapus')
  }
}
