import { UserRepository } from '../repositories/UserRepository'
import { verifyPassword } from '../utils/password'
import { signToken } from '../utils/token'
import { AppError } from '../utils/AppError'
import { AuditService } from './AuditService'

interface AuthRequestContext {
  requestId?: string
  ip?: string
}

export class AuthService {
  constructor(
    private users = new UserRepository(),
    private audit = new AuditService(),
  ) {}

  async login(email: string, password: string, context: AuthRequestContext = {}) {
    const normalizedEmail = email.trim().toLowerCase()
    const user = await this.users.findByEmail(normalizedEmail)

    if (!user || user.status !== 'active') {
      await this.safeAudit({
        companyId: user?.company_id,
        userId: user?.id,
        module: 'auth',
        action: 'login_failed',
        newValue: { email: normalizedEmail, reason: user ? user.status : 'not_found' },
        ...context,
      })
      throw new AppError('Email atau password salah', 401)
    }

    const isPasswordValid = await verifyPassword(password, user.password)

    if (!isPasswordValid) {
      await this.users.recordFailedLogin(user.id)
      await this.safeAudit({
        companyId: user.company_id,
        userId: user.id,
        module: 'auth',
        action: 'login_failed',
        newValue: { email: normalizedEmail, reason: 'invalid_credentials' },
        ...context,
      })
      throw new AppError('Email atau password salah', 401)
    }

    const access = await this.users.authContext(user.id)
    const authUser = {
      id: user.id,
      companyId: user.company_id,
      name: user.name,
      email: user.email,
      ...access,
    }

    await this.users.touchLogin(user.id)
    await this.safeAudit({
      companyId: user.company_id,
      userId: user.id,
      module: 'auth',
      action: 'login',
      newValue: { email: user.email },
      ...context,
    })

    return {
      token: signToken(authUser),
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        roles: access.roles,
        permissions: access.permissions,
      },
    }
  }

  async logout(user: { id: number; companyId: number; email: string }, context: AuthRequestContext) {
    await this.safeAudit({
      companyId: user.companyId,
      userId: user.id,
      module: 'auth',
      action: 'logout',
      newValue: { email: user.email },
      ...context,
    })
  }

  private async safeAudit(input: Parameters<AuditService['log']>[1]) {
    try {
      await this.audit.log(undefined, input)
    } catch (error) {
      console.error('Gagal menyimpan audit autentikasi', error)
    }
  }
}
