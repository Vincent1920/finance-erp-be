import { cors } from 'hono/cors'
import { env } from './env'

const allowedOrigins =
  env.APP_ENV === 'development'
    ? Array.from(
        new Set([
          env.FRONTEND_URL,
          env.FRONTEND_URL.replace('localhost', '127.0.0.1'),
          env.FRONTEND_URL.replace('127.0.0.1', 'localhost'),
        ]),
      )
    : env.FRONTEND_URL

export const corsMiddleware = cors({
  origin: allowedOrigins,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Request-Id','X-CSRF-Token','X-Auth-Transport'],
  exposeHeaders: ['X-Request-Id','X-CSRF-Token','X-Auth-Transport'],
  credentials: true,
})
