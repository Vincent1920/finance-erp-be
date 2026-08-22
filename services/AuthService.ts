import { UserRepository } from '../repositories/UserRepository'
import { verifyPassword } from '../utils/password'
import { signToken } from '../utils/token'
import { AppError } from '../utils/AppError'

export class AuthService {
  constructor(private users = new UserRepository()) {}

  async login(email: string, password: string) {
    const user = await this.users.findByEmail(email)

    if (!user || user.status !== 'active') {
      throw new AppError('Email atau password salah', 401)
    }

    const isPasswordValid = await verifyPassword(password, user.password)

    if (!isPasswordValid) {
      throw new AppError('Email atau password salah', 401)
    }

    const access = await this.users.authContext(user.id)
    const authUser = { id: user.id, companyId: user.company_id, email: user.email, ...access }

    await this.users.touchLogin(user.id)

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
}
