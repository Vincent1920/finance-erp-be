import { transaction } from '../config/database'
import { RoleRepository } from '../repositories/RoleRepository'
import { ConflictError, ForbiddenError, NotFoundError } from '../utils/AppError'
import { AuditService } from './AuditService'
import type { SystemActor } from './SystemUserService'

type RoleInput = {
  name: string
  slug: string
  description?: string | null
  is_active: boolean
  permission_ids?: number[]
}

export class RoleService {
  constructor(
    private readonly roles = new RoleRepository(),
    private readonly audit = new AuditService(),
  ) {}

  list(companyId: number, query: Record<string, string>) {
    return this.roles.list(companyId, query)
  }

  permissionList(query: Record<string, string>) {
    return this.roles.permissionList(query)
  }

  async get(id: number, companyId: number) {
    const role = await this.roles.find(id, companyId)
    if (!role) throw new NotFoundError('Peran tidak ditemukan')
    return role
  }

  async getPermission(id: number) {
    const permission = await this.roles.findPermission(id)
    if (!permission) throw new NotFoundError('Permission tidak ditemukan')
    return permission
  }

  async create(actor: SystemActor, input: RoleInput) {
    return transaction(async (connection) => {
      const permissionIds = [...new Set(input.permission_ids ?? [])]
      const valid = await this.roles.validatePermissions(permissionIds, connection)
      if (valid.length !== permissionIds.length)
        throw new ConflictError('Satu atau lebih permission tidak valid')
      const id = await this.roles.create(actor.companyId, input, connection)
      await this.roles.assignPermissions(id, permissionIds, connection)
      const role = await this.roles.find(id, actor.companyId, connection)
      await this.audit.log(connection, {
        companyId: actor.companyId,
        userId: actor.id,
        module: 'roles',
        action: 'create',
        recordType: 'role',
        recordId: id,
        newValue: role,
        requestId: actor.requestId,
        ip: actor.ip,
      })
      return role
    })
  }

  async update(actor: SystemActor, id: number, input: Partial<RoleInput>) {
    return transaction(async (connection) => {
      const oldValue = await this.roles.find(id, actor.companyId, connection)
      if (!oldValue) throw new NotFoundError('Peran tidak ditemukan')
      if (oldValue.is_system || oldValue.company_id === null)
        throw new ForbiddenError('Peran sistem tidak dapat diubah')
      await this.roles.update(id, actor.companyId, input, connection)
      const role = await this.roles.find(id, actor.companyId, connection)
      await this.audit.log(connection, {
        companyId: actor.companyId,
        userId: actor.id,
        module: 'roles',
        action: 'update',
        recordType: 'role',
        recordId: id,
        oldValue,
        newValue: role,
        requestId: actor.requestId,
        ip: actor.ip,
      })
      return role
    })
  }

  async assignPermissions(actor: SystemActor, id: number, permissionIdsInput: number[]) {
    return transaction(async (connection) => {
      const oldValue = await this.roles.find(id, actor.companyId, connection)
      if (!oldValue) throw new NotFoundError('Peran tidak ditemukan')
      if (oldValue.is_system || oldValue.company_id === null)
        throw new ForbiddenError('Permission peran sistem dikelola oleh seeder')
      const permissionIds = [...new Set(permissionIdsInput)]
      const valid = await this.roles.validatePermissions(permissionIds, connection)
      if (valid.length !== permissionIds.length)
        throw new ConflictError('Satu atau lebih permission tidak valid')
      await this.roles.assignPermissions(id, permissionIds, connection)
      const role = await this.roles.find(id, actor.companyId, connection)
      await this.audit.log(connection, {
        companyId: actor.companyId,
        userId: actor.id,
        module: 'roles',
        action: 'assign_permissions',
        recordType: 'role',
        recordId: id,
        oldValue,
        newValue: role,
        requestId: actor.requestId,
        ip: actor.ip,
      })
      return role
    })
  }

  async remove(actor: SystemActor, id: number) {
    return transaction(async (connection) => {
      const oldValue = await this.roles.find(id, actor.companyId, connection)
      if (!oldValue) throw new NotFoundError('Peran tidak ditemukan')
      if (oldValue.is_system || oldValue.company_id === null)
        throw new ForbiddenError('Peran sistem tidak dapat dihapus')
      await this.roles.deactivate(id, actor.companyId, connection)
      await this.audit.log(connection, {
        companyId: actor.companyId,
        userId: actor.id,
        module: 'roles',
        action: 'deactivate',
        recordType: 'role',
        recordId: id,
        oldValue,
        requestId: actor.requestId,
        ip: actor.ip,
      })
    })
  }

  async createPermission(
    actor: SystemActor,
    input: { module: string; action: string; name: string },
  ) {
    this.requireSuperAdmin(actor)
    return transaction(async (connection) => {
      const id = await this.roles.createPermission(input, connection)
      const permission = await this.roles.findPermission(id, connection)
      await this.audit.log(connection, {
        companyId: actor.companyId,
        userId: actor.id,
        module: 'roles',
        action: 'create_permission',
        recordType: 'permission',
        recordId: id,
        newValue: permission,
        requestId: actor.requestId,
        ip: actor.ip,
      })
      return permission
    })
  }

  async updatePermission(
    actor: SystemActor,
    id: number,
    input: Partial<{ module: string; action: string; name: string }>,
  ) {
    this.requireSuperAdmin(actor)
    return transaction(async (connection) => {
      const oldValue = await this.roles.findPermission(id, connection)
      if (!oldValue) throw new NotFoundError('Permission tidak ditemukan')
      const merged = {
        module: String(input.module ?? oldValue.module),
        action: String(input.action ?? oldValue.action),
        name: String(input.name ?? oldValue.name),
      }
      await this.roles.updatePermission(id, merged, connection)
      const permission = await this.roles.findPermission(id, connection)
      await this.audit.log(connection, {
        companyId: actor.companyId,
        userId: actor.id,
        module: 'roles',
        action: 'update_permission',
        recordType: 'permission',
        recordId: id,
        oldValue,
        newValue: permission,
        requestId: actor.requestId,
        ip: actor.ip,
      })
      return permission
    })
  }

  async deletePermission(actor: SystemActor, id: number) {
    this.requireSuperAdmin(actor)
    return transaction(async (connection) => {
      const permission = await this.roles.findPermission(id, connection)
      if (!permission) throw new NotFoundError('Permission tidak ditemukan')
      if (await this.roles.permissionInUse(id, connection))
        throw new ConflictError('Permission masih digunakan oleh peran')
      await this.roles.deletePermission(id, connection)
      await this.audit.log(connection, {
        companyId: actor.companyId,
        userId: actor.id,
        module: 'roles',
        action: 'delete_permission',
        recordType: 'permission',
        recordId: id,
        oldValue: permission,
        requestId: actor.requestId,
        ip: actor.ip,
      })
    })
  }

  private requireSuperAdmin(actor: SystemActor) {
    if (!actor.roles.includes('super-admin'))
      throw new ForbiddenError('Hanya Super Admin yang dapat mengubah katalog permission')
  }
}
