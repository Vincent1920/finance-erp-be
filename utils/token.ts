import jwt, { type SignOptions } from 'jsonwebtoken'
import { env } from '../config/env'
import type { AuthUser } from '../types/hono'
export const signToken = (user: AuthUser) =>
  jwt.sign(user, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'] })
export const verifyToken = (token: string) => jwt.verify(token, env.JWT_SECRET) as AuthUser
