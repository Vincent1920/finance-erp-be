import bcrypt from 'bcryptjs'
import { env } from '../config/env'
export const hashPassword = (value: string) => bcrypt.hash(value, env.BCRYPT_ROUNDS)
export const verifyPassword = (value: string, hash: string) => bcrypt.compare(value, hash)
