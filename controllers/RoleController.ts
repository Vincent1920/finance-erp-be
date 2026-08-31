import type { Context } from 'hono'
import { RoleService } from '../services/RoleService'
import { created, ok, paginated } from '../utils/response'
import { systemActor } from '../utils/request-context'
import {
  assignPermissionsSchema,
  createPermissionSchema,
  createRoleSchema,
  updatePermissionSchema,
  updateRoleSchema,
} from '../validators/system.validator'

export class RoleController {
  constructor(private readonly service = new RoleService()) {}

  list = async (c: Context) => {
    const result = await this.service.list(c.get('user').companyId, c.req.query())
    return paginated(c, result.rows, result)
  }
  get = async (c: Context) =>
    ok(c, await this.service.get(Number(c.req.param('id')), c.get('user').companyId))
  create = async (c: Context) =>
    created(c, await this.service.create(systemActor(c), createRoleSchema.parse(await c.req.json())))
  update = async (c: Context) =>
    ok(
      c,
      await this.service.update(
        systemActor(c),
        Number(c.req.param('id')),
        updateRoleSchema.parse(await c.req.json()),
      ),
      'Peran berhasil diperbarui',
    )
  permissions = async (c: Context) => {
    const { permission_ids } = assignPermissionsSchema.parse(await c.req.json())
    return ok(
      c,
      await this.service.assignPermissions(
        systemActor(c),
        Number(c.req.param('id')),
        permission_ids,
      ),
      'Permission peran berhasil diperbarui',
    )
  }
  remove = async (c: Context) => {
    await this.service.remove(systemActor(c), Number(c.req.param('id')))
    return ok(c, null, 'Peran berhasil dinonaktifkan')
  }

  permissionList = async (c: Context) => {
    const result = await this.service.permissionList(c.req.query())
    return paginated(c, result.rows, result)
  }
  permissionGet = async (c: Context) =>
    ok(c, await this.service.getPermission(Number(c.req.param('id'))))
  permissionCreate = async (c: Context) =>
    created(
      c,
      await this.service.createPermission(
        systemActor(c),
        createPermissionSchema.parse(await c.req.json()),
      ),
    )
  permissionUpdate = async (c: Context) =>
    ok(
      c,
      await this.service.updatePermission(
        systemActor(c),
        Number(c.req.param('id')),
        updatePermissionSchema.parse(await c.req.json()),
      ),
      'Permission berhasil diperbarui',
    )
  permissionRemove = async (c: Context) => {
    await this.service.deletePermission(systemActor(c), Number(c.req.param('id')))
    return ok(c, null, 'Permission berhasil dihapus')
  }
}
