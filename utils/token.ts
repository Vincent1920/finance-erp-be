import jwt, { type SignOptions } from 'jsonwebtoken'
import { env } from '../config/env'
import type { AuthUser } from '../types/hono'

export type AuthTokenClaims = Pick<AuthUser, 'id' | 'companyId'>

// Access is loaded fresh by authMiddleware. Embedding thousands of permissions
// here made the Authorization header exceed the HTTP server's header limit.
export const signToken = ({ id, companyId }: AuthTokenClaims) =>
  jwt.sign({ id, companyId }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'],
  })

export const verifyToken = (token: string) =>
  jwt.verify(token, env.JWT_SECRET) as AuthTokenClaims
