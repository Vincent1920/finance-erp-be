import { transaction } from '../config/database'
import { SystemUserRepository } from '../repositories/SystemUserRepository'
import { ConflictError, ForbiddenError, NotFoundError } from '../utils/AppError'
import { hashPassword } from '../utils/password'
import { AuditService } from './AuditService'

export interface SystemActor {
  id: number
  companyId: number
  roles: string[]
  requestId?: string
  ip?: string
}

export class SystemUserService {
  constructor(
    private readonly users = new SystemUserRepository(),
    private readonly audit = new AuditService(),
  ) {}

  list(companyId: number, query: Record<string, string>) {
    return this.users.list(companyId, query)
  }

  async get(id: number, companyId: number) {
    const user = await this.users.find(id, companyId)
    if (!user) throw new NotFoundError('Pengguna tidak ditemukan')
    return user
  }

  async create(
    actor: SystemActor,
    input: {
      name: string
      email: string
      password: string
      status: 'active' | 'inactive' | 'locked'
      role_ids: number[]
    },
  ) {
    const passwordHash = await hashPassword(input.password)
    return transaction(async (connection) => {
      const roleIds = [...new Set(input.role_ids)]
      const validRoles = await this.users.validateRoles(
        roleIds,
        actor.companyId,
        actor.roles.includes('super-admin'),
        connection,
      )
      if (validRoles.length !== roleIds.length)
        throw new ConflictError('Satu atau lebih peran tidak valid untuk perusahaan ini')
      const id = await this.users.create(
        actor.companyId,
        { ...input, password: passwordHash },
        actor.id,
        connection,
      )
      await this.users.assignRoles(id, roleIds, connection)
      if (input.status === 'locked')
        await this.users.setStatus(id, actor.companyId, 'locked', actor.id, connection)
      const user = await this.users.find(id, actor.companyId, connection)
      await this.audit.log(connection, {
        companyId: actor.companyId,
        userId: actor.id,
        module: 'users',
        action: 'create',
        recordType: 'user',
        recordId: id,
        newValue: user,
        requestId: actor.requestId,
        ip: actor.ip,
      })
      return user
    })
  }

  async update(actor: SystemActor, id: number, input: { name?: string; email?: string }) {
    return transaction(async (connection) => {
      const oldValue = await this.users.find(id, actor.companyId, connection)
      if (!oldValue) throw new NotFoundError('Pengguna tidak ditemukan')
      await this.users.update(id, actor.companyId, input, actor.id, connection)
      const user = await this.users.find(id, actor.companyId, connection)
      await this.audit.log(connection, {
        companyId: actor.companyId,
        userId: actor.id,
        module: 'users',
        action: 'update',
        recordType: 'user',
        recordId: id,
        oldValue,
        newValue: user,
        requestId: actor.requestId,
        ip: actor.ip,
      })
      return user
    })
  }

  async setStatus(
    actor: SystemActor,
    id: number,
    status: 'active' | 'inactive' | 'locked',
  ) {
    if (actor.id === id && status !== 'active')
      throw new ForbiddenError('Tidak dapat menonaktifkan atau mengunci akun sendiri')
    return transaction(async (connection) => {
      const oldValue = await this.users.find(id, actor.companyId, connection)
      if (!oldValue) throw new NotFoundError('Pengguna tidak ditemukan')
      await this.users.setStatus(id, actor.companyId, status, actor.id, connection)
      const user = await this.users.find(id, actor.companyId, connection)
      await this.audit.log(connection, {
        companyId: actor.companyId,
        userId: actor.id,
        module: 'users',
        action: status === 'active' ? 'activate' : status === 'locked' ? 'lock' : 'deactivate',
        recordType: 'user',
        recordId: id,
        oldValue,
        newValue: user,
        requestId: actor.requestId,
        ip: actor.ip,
      })
      return user
    })
  }

  async resetPassword(actor: SystemActor, id: number, password: string) {
    const passwordHash = await hashPassword(password)
    return transaction(async (connection) => {
      const user = await this.users.find(id, actor.companyId, connection)
      if (!user) throw new NotFoundError('Pengguna tidak ditemukan')
      await this.users.resetPassword(id, actor.companyId, passwordHash, actor.id, connection)
      await this.audit.log(connection, {
        companyId: actor.companyId,
        userId: actor.id,
        module: 'users',
        action: 'reset_password',
        recordType: 'user',
        recordId: id,
        newValue: { passwordChanged: true },
        requestId: actor.requestId,
        ip: actor.ip,
      })
      return this.users.find(id, actor.companyId, connection)
    })
  }

  async assignRoles(actor: SystemActor, id: number, roleIdsInput: number[]) {
    return transaction(async (connection) => {
      const oldValue = await this.users.find(id, actor.companyId, connection)
      if (!oldValue) throw new NotFoundError('Pengguna tidak ditemukan')
      const roleIds = [...new Set(roleIdsInput)]
      const valid = await this.users.validateRoles(
        roleIds,
        actor.companyId,
        actor.roles.includes('super-admin'),
        connection,
      )
      if (valid.length !== roleIds.length)
        throw new ConflictError('Satu atau lebih peran tidak valid untuk perusahaan ini')
      if (id === actor.id && roleIds.length === 0)
        throw new ForbiddenError('Tidak dapat menghapus seluruh peran akun sendiri')
      await this.users.assignRoles(id, roleIds, connection)
      const user = await this.users.find(id, actor.companyId, connection)
      await this.audit.log(connection, {
        companyId: actor.companyId,
        userId: actor.id,
        module: 'users',
        action: 'assign_roles',
        recordType: 'user',
        recordId: id,
        oldValue,
        newValue: user,
        requestId: actor.requestId,
        ip: actor.ip,
      })
      return user
    })
  }

  async remove(actor: SystemActor, id: number) {
    if (actor.id === id) throw new ForbiddenError('Tidak dapat menghapus akun sendiri')
    return transaction(async (connection) => {
      const oldValue = await this.users.find(id, actor.companyId, connection)
      if (!oldValue) throw new NotFoundError('Pengguna tidak ditemukan')
      await this.users.softDelete(id, actor.companyId, actor.id, connection)
      await this.audit.log(connection, {
        companyId: actor.companyId,
        userId: actor.id,
        module: 'users',
        action: 'delete',
        recordType: 'user',
        recordId: id,
        oldValue,
        requestId: actor.requestId,
        ip: actor.ip,
      })
    })
  }
}
