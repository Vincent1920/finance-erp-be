import {setAuthCookies,clearAuthCookies,browserOrigin} from '../utils/auth-cookie'
import {env} from '../config/env'
import {clientAddress} from '../middleware/login-rate-limit.middleware'
import {AuthSessionService} from '../services/AuthSessionService'
import {z} from 'zod'
import type { Context } from 'hono'
import { AuthService } from '../services/AuthService'
import { loginSchema } from '../validators/auth.validator'
import { ok } from '../utils/response'

const requestContext = (c: Context) => ({
  requestId: c.get('requestId'),
  device:c.req.header('user-agent'),
  sessionId:c.get('sessionId'),
  ip:clientAddress(c),
})

export class AuthController {
  constructor(private service = new AuthService()) {}
  login=async(c:Context)=>{browserOrigin(c);const input=loginSchema.parse(await c.req.json());const result=await this.service.login(input.email,input.password,{...requestContext(c),mfaCode:input.mfa_code});if(env.APP_ENV==='production'||c.req.header('X-Auth-Transport')==='cookie'){setAuthCookies(c,result.token,input.remember);return ok(c,{user:result.user,transport:'cookie'},'Login berhasil')}return ok(c,result,'Login berhasil')}
  sessions=async(c:Context)=>ok(c,await new AuthSessionService().list(c.get('user').id,c.get('user').companyId,c.get('sessionId')))
  revokeSession=async(c:Context)=>{await new AuthSessionService().revoke(c.get('user').id,c.get('user').companyId,z.uuid().parse(c.req.param('id')));return ok(c,null,'Sesi ditutup')}
  revokeAll=async(c:Context)=>{await new AuthSessionService().revoke(c.get('user').id,c.get('user').companyId,'',true);clearAuthCookies(c);return ok(c,null,'Semua sesi ditutup')}
  me = (c: Context) => ok(c, c.get('user'))
  logout = async (c: Context) => {
    await this.service.logout(c.get('user'), requestContext(c))
    clearAuthCookies(c)
    return ok(c, null, 'Logout berhasil')
  }
}
