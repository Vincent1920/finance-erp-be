export interface AuthUser {
  id: number
  companyId: number
  email: string
  roles: string[]
  permissions: string[]
}
export type AppBindings = { Variables: { requestId: string; user: AuthUser } }
