import { Hono } from 'hono'
import { AuthController } from '../controllers/AuthController'
import { authMiddleware } from '../middleware/auth.middleware'
import { loginRateLimit } from '../middleware/login-rate-limit.middleware'
const route = new Hono(),
  controller = new AuthController()
route.post('/login', loginRateLimit, controller.login)
route.get('/me', authMiddleware, controller.me)
route.post('/logout', authMiddleware, controller.logout)
export default route
