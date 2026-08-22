import { cors } from 'hono/cors'
import { env } from './env'
export const corsMiddleware = cors({
  origin: env.FRONTEND_URL,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  exposeHeaders: ['X-Request-Id'],
  credentials: true,
})
