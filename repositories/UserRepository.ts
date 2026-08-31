import type { RowDataPacket } from 'mysql2'

import { db } from '../config/database'

export interface UserRow extends RowDataPacket {
  id: number
  company_id: number
  name: string
  email: string
  password: string
  status: string
  failed_login_attempts: number
}

interface SlugRow extends RowDataPacket {
  slug: string
}

export class UserRepository {
  async findByEmail(email: string) {
    const [rows] = await db.execute<UserRow[]>(
      `SELECT *
       FROM users
       WHERE email = ? AND deleted_at IS NULL
       LIMIT 1`,
      [email],
    )

    return rows[0] ?? null
  }

  async authContext(userId: number) {
    const [roles] = await db.execute<SlugRow[]>(
      `SELECT r.slug
       FROM roles r
       INNER JOIN user_roles ur ON ur.role_id = r.id
       INNER JOIN users u ON u.id = ur.user_id
       WHERE ur.user_id = ?
         AND r.is_active = TRUE
         AND (r.company_id IS NULL OR r.company_id = u.company_id)`,
      [userId],
    )

    const [permissions] = await db.execute<SlugRow[]>(
      `SELECT DISTINCT p.slug
       FROM permissions p
       INNER JOIN role_permissions rp ON rp.permission_id = p.id
       INNER JOIN user_roles ur ON ur.role_id = rp.role_id
       INNER JOIN roles r ON r.id = ur.role_id
       INNER JOIN users u ON u.id = ur.user_id
       WHERE ur.user_id = ?
         AND r.is_active = TRUE
         AND (r.company_id IS NULL OR r.company_id = u.company_id)`,
      [userId],
    )

    return {
      roles: roles.map((x) => String(x.slug)),
      permissions: permissions.map((x) => String(x.slug)),
    }
  }

  async touchLogin(id: number) {
    await db.execute(
      `UPDATE users
       SET last_login_at = NOW(), failed_login_attempts = 0, last_failed_login_at = NULL
       WHERE id = ?`,
      [id],
    )
  }

  async recordFailedLogin(id: number) {
    await db.execute(
      `UPDATE users
       SET failed_login_attempts = failed_login_attempts + 1,
           last_failed_login_at = NOW(),
           status = IF(failed_login_attempts + 1 >= 5, 'locked', status),
           locked_at = IF(failed_login_attempts + 1 >= 5, COALESCE(locked_at, NOW()), locked_at)
       WHERE id = ?`,
      [id],
    )
  }

  async freshAuthUser(id: number, companyId: number) {
    const [rows] = await db.execute<UserRow[]>(
      `SELECT u.id, u.company_id, u.name, u.email, u.status, u.failed_login_attempts
       FROM users u
       INNER JOIN companies c ON c.id = u.company_id
       WHERE u.id = ? AND u.company_id = ? AND u.deleted_at IS NULL
       LIMIT 1`,
      [id, companyId],
    )
    const user = rows[0]
    if (!user || user.status !== 'active') return null
    const access = await this.authContext(user.id)
    return {
      id: user.id,
      companyId: user.company_id,
      name: user.name,
      email: user.email,
      ...access,
    }
  }
}
