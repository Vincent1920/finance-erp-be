export interface AuthUser {
  id: number
  companyId: number
  isPlatformOperator?: boolean
  name: string
  email: string
  roles: string[]
  permissions: string[]
}
export type AppBindings = { Variables: { requestId: string; sessionId: string; user: AuthUser } }
