import 'dotenv/config'
import { z } from 'zod'
const schema = z.object({
  APP_NAME: z.string().default('Finance ERP'),
  APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_PORT: z.coerce.number().int().positive().default(8000),
  FRONTEND_URL: z.string().url(),
  DB_HOST: z.string(),
  DB_PORT: z.coerce.number().int().positive(),
  DB_NAME: z.string(),
  DB_USER: z.string(),
  DB_PASSWORD: z.string().default(''),
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default('8h'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(8).max(15).default(12),
})
export const env = schema.parse(process.env)
