import type { Context } from 'hono'
import { AuthService } from '../services/AuthService'
import { loginSchema } from '../validators/auth.validator'
import { ok } from '../utils/response'

const requestContext = (c: Context) => ({
  requestId: c.get('requestId'),
  ip:
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-real-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim(),
})

export class AuthController {
  constructor(private service = new AuthService()) {}
  login = async (c: Context) =>
    ok(
      c,
      await this.service.login(
        ...(({ email, password }) => [email, password] as const)(
          loginSchema.parse(await c.req.json()),
        ),
        requestContext(c),
      ),
      'Login berhasil',
    )
  me = (c: Context) => ok(c, c.get('user'))
  logout = async (c: Context) => {
    await this.service.logout(c.get('user'), requestContext(c))
    return ok(c, null, 'Logout berhasil')
  }
}
