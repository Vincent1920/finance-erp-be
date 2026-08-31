export interface AuthUser {
  id: number
  companyId: number
  name: string
  email: string
  roles: string[]
  permissions: string[]
}
export type AppBindings = { Variables: { requestId: string; user: AuthUser } }
