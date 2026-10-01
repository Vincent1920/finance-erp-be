import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { db, transaction } from '../config/database'
import { NotFoundError } from '../utils/AppError'

export class SavedViewService {
  async list(companyId: number, userId: number, screenKey: string) {
    const [rows] = await db.execute<RowDataPacket[]>(
      'SELECT id,screen_key,name,filters,is_default,created_at,updated_at FROM user_saved_views WHERE company_id=? AND user_id=? AND screen_key=? ORDER BY is_default DESC,name',
      [companyId, userId, screenKey],
    )
    return rows.map((row) => ({ ...row, filters: typeof row.filters === 'string' ? JSON.parse(row.filters) : row.filters }))
  }

  save(companyId: number, userId: number, input: { screen_key: string; name: string; filters: Record<string, unknown>; is_default: boolean }) {
    return transaction(async (connection) => {
      if (input.is_default) await connection.execute('UPDATE user_saved_views SET is_default=FALSE WHERE company_id=? AND user_id=? AND screen_key=?', [companyId, userId, input.screen_key])
      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO user_saved_views(company_id,user_id,screen_key,name,filters,is_default) VALUES(?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE filters=VALUES(filters),is_default=VALUES(is_default),updated_at=NOW()`,
        [companyId, userId, input.screen_key, input.name, JSON.stringify(input.filters), input.is_default],
      )
      const [rows] = await connection.execute<RowDataPacket[]>('SELECT id,screen_key,name,filters,is_default FROM user_saved_views WHERE company_id=? AND user_id=? AND screen_key=? AND name=?', [companyId, userId, input.screen_key, input.name])
      return { ...rows[0], id: Number(rows[0]?.id ?? result.insertId), filters: input.filters }
    })
  }

  async remove(companyId: number, userId: number, id: number) {
    const [result] = await db.execute<ResultSetHeader>('DELETE FROM user_saved_views WHERE id=? AND company_id=? AND user_id=?', [id, companyId, userId])
    if (!result.affectedRows) throw new NotFoundError('Filter tersimpan tidak ditemukan')
    return { deleted: true }
  }
}
