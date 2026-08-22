import type { Context } from 'hono'
import { AuthService } from '../services/AuthService'
import { loginSchema } from '../validators/auth.validator'
import { ok } from '../utils/response'
export class AuthController {
  constructor(private service = new AuthService()) {}
  login = async (c: Context) =>
    ok(
      c,
      await this.service.login(
        ...(({ email, password }) => [email, password] as const)(
          loginSchema.parse(await c.req.json()),
        ),
      ),
      'Login berhasil',
    )
  me = (c: Context) => ok(c, c.get('user'))
  logout = (c: Context) => ok(c, null, 'Logout berhasil')
}
