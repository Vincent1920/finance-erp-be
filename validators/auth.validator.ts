import { z } from 'zod'
export const loginSchema = z.object({
  remember:z.boolean().default(true),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
  mfa_code:z.string().trim().max(40).optional(),
})
