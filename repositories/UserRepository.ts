import type { RowDataPacket } from 'mysql2'

import { db } from '../config/database'

export interface UserRow extends RowDataPacket {
  id: number
  company_id: number
  name: string
  email: string
  password: string
  status: string
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
       WHERE ur.user_id = ?`,
      [userId],
    )

    const [permissions] = await db.execute<SlugRow[]>(
      `SELECT DISTINCT p.slug
       FROM permissions p
       INNER JOIN role_permissions rp ON rp.permission_id = p.id
       INNER JOIN user_roles ur ON ur.role_id = rp.role_id
       WHERE ur.user_id = ?`,
      [userId],
    )

    return {
      roles: roles.map((x) => String(x.slug)),
      permissions: permissions.map((x) => String(x.slug)),
    }
  }

  async touchLogin(id: number) {
    await db.execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [id])
  }
}
