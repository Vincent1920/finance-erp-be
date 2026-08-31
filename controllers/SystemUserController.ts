import type { Context } from 'hono'
import { SystemUserService } from '../services/SystemUserService'
import { created, ok, paginated } from '../utils/response'
import { systemActor } from '../utils/request-context'
import {
  assignRolesSchema,
  createUserSchema,
  resetPasswordSchema,
  updateUserSchema,
  userStatusSchema,
} from '../validators/system.validator'

export class SystemUserController {
  constructor(private readonly service = new SystemUserService()) {}

  list = async (c: Context) => {
    const result = await this.service.list(c.get('user').companyId, c.req.query())
    return paginated(c, result.rows, result)
  }

  get = async (c: Context) =>
    ok(c, await this.service.get(Number(c.req.param('id')), c.get('user').companyId))

  create = async (c: Context) =>
    created(c, await this.service.create(systemActor(c), createUserSchema.parse(await c.req.json())))

  update = async (c: Context) =>
    ok(
      c,
      await this.service.update(
        systemActor(c),
        Number(c.req.param('id')),
        updateUserSchema.parse(await c.req.json()),
      ),
      'Pengguna berhasil diperbarui',
    )

  status = async (c: Context) => {
    const { status } = userStatusSchema.parse(await c.req.json())
    return ok(
      c,
      await this.service.setStatus(systemActor(c), Number(c.req.param('id')), status),
      'Status pengguna berhasil diperbarui',
    )
  }

  activate = (c: Context) => this.statusValue(c, 'active')
  deactivate = (c: Context) => this.statusValue(c, 'inactive')
  lock = (c: Context) => this.statusValue(c, 'locked')

  resetPassword = async (c: Context) => {
    const { password } = resetPasswordSchema.parse(await c.req.json())
    return ok(
      c,
      await this.service.resetPassword(systemActor(c), Number(c.req.param('id')), password),
      'Password berhasil direset',
    )
  }

  roles = async (c: Context) => {
    const { role_ids } = assignRolesSchema.parse(await c.req.json())
    return ok(
      c,
      await this.service.assignRoles(systemActor(c), Number(c.req.param('id')), role_ids),
      'Peran pengguna berhasil diperbarui',
    )
  }

  remove = async (c: Context) => {
    await this.service.remove(systemActor(c), Number(c.req.param('id')))
    return ok(c, null, 'Pengguna berhasil dinonaktifkan dan dihapus')
  }

  private async statusValue(c: Context, status: 'active' | 'inactive' | 'locked') {
    return ok(
      c,
      await this.service.setStatus(systemActor(c), Number(c.req.param('id')), status),
      'Status pengguna berhasil diperbarui',
    )
  }
}
