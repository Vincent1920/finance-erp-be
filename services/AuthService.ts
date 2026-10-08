import {assertTenantAccess} from './TenantAccessService'
import {MfaService} from './MfaService'
import {isPlatformOperator} from '../middleware/role.middleware'
import { AuthSessionService,securityNumber } from './AuthSessionService'
import { db,transaction } from '../config/database'
import { UserRepository } from '../repositories/UserRepository'
import { verifyPassword } from '../utils/password'
import { signToken } from '../utils/token'
import { AppError } from '../utils/AppError'
import { AuditService } from './AuditService'

interface AuthRequestContext {
  requestId?: string
  mfaCode?: string
  device?: string
  sessionId?: string
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
        requestId:context.requestId,ip:context.ip,
      })
      throw new AppError('Email atau password salah', 401)
    }

    const limit=await securityNumber(user.company_id,'security.max_login_attempts',5,1,100)
    await transaction(async cx=>{
      const [rows]=await cx.query<any[]>('SELECT password,status,failed_login_attempts,last_failed_login_at,TIMESTAMPDIFF(SECOND,last_failed_login_at,UTC_TIMESTAMP()) failure_age FROM users WHERE id=? AND company_id=? FOR UPDATE',[user.id,user.company_id])
      const fresh=rows[0]
      if(!fresh||fresh.status!=='active')throw new AppError('Email atau password salah',401)
      if(Number(fresh.failed_login_attempts)>=limit&&fresh.last_failed_login_at&&Number(fresh.failure_age)<900)throw new AppError('Terlalu banyak percobaan login. Coba lagi setelah 15 menit.',429)
      const valid=await verifyPassword(password,fresh.password)
      if(!valid){
        const next=fresh.last_failed_login_at&&Number(fresh.failure_age)<900?Number(fresh.failed_login_attempts)+1:1
        await cx.execute('UPDATE users SET failed_login_attempts=?,last_failed_login_at=UTC_TIMESTAMP() WHERE id=?',[next,user.id])
        return false
      }
      await cx.execute('UPDATE users SET failed_login_attempts=0,last_failed_login_at=NULL WHERE id=?',[user.id]);return true
    }).then(async valid=>{if(!valid){await this.safeAudit({companyId:user.company_id,userId:user.id,module:'auth',action:'login_failed',newValue:{reason:'invalid_credentials'},requestId:context.requestId,ip:context.ip});throw new AppError('Email atau password salah',401)}})

    if(!isPlatformOperator(Number(user.id)))await assertTenantAccess(Number(user.company_id))
    const mfaVerified=await new MfaService().verifyLogin(user.id,context.mfaCode)
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
      requestId:context.requestId,ip:context.ip,
    })

    const token=signToken(authUser)
    await new AuthSessionService().register(token,user.id,user.company_id,context.device,user.password,mfaVerified)
    return {
      token,
      user: {
        id: user.id,
        companyId: user.company_id,
        name: user.name,
        email: user.email,
        roles: access.roles,
        permissions: access.permissions,
        baseCurrency: String(user.base_currency),
        isPlatformOperator:isPlatformOperator(Number(user.id)),
      },
    }
  }

  async logout(user: { id: number; companyId: number; email: string }, context: AuthRequestContext) {
    if(context.sessionId)await new AuthSessionService().revoke(user.id,user.companyId,context.sessionId)
    await this.safeAudit({
      companyId: user.companyId,
      userId: user.id,
      module: 'auth',
      action: 'logout',
      newValue: { email: user.email },
      requestId:context.requestId,ip:context.ip,
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
