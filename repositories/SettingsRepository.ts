import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import { db } from '../config/database'
import type { DatabaseValue, QueryExecutor } from '../types/database'

export interface SettingInput {
  key: string
  value: string | null
  value_type: 'string' | 'number' | 'boolean' | 'json' | 'account_id'
  category: string
  is_secret: boolean
}

export class SettingsRepository {
  async list(companyId: number, category?: string, connection: QueryExecutor = db) {
    const values: DatabaseValue[] = [companyId]
    const categoryFilter = category ? 'AND category = ?' : ''
    if (category) values.push(category)
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT id, setting_key, setting_value, value_type, category, is_secret,
              created_at, updated_at
       FROM settings
       WHERE company_id = ? ${categoryFilter}
       ORDER BY category, setting_key`,
      values,
    )
    return rows
  }

  async find(companyId: number, key: string, connection: QueryExecutor = db) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT id, setting_key, setting_value, value_type, category, is_secret,
              created_at, updated_at
       FROM settings
       WHERE company_id = ? AND setting_key = ?
       LIMIT 1`,
      [companyId, key],
    )
    return rows[0] ?? null
  }

  async upsert(companyId: number, input: SettingInput, connection: QueryExecutor) {
    await connection.execute<ResultSetHeader>(
      `INSERT INTO settings (
         company_id, setting_key, setting_value, value_type, category, is_secret
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         setting_value = VALUES(setting_value), value_type = VALUES(value_type),
         category = VALUES(category), is_secret = VALUES(is_secret)`,
      [companyId, input.key, input.value, input.value_type, input.category, input.is_secret],
    )
    return this.find(companyId, input.key, connection)
  }

  async company(companyId: number, connection: QueryExecutor = db) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT id, name, legal_name, tax_number, address, phone, email, logo,
              base_currency, fiscal_year_start, created_at, updated_at
       FROM companies WHERE id = ? LIMIT 1`,
      [companyId],
    )
    return rows[0] ?? null
  }

  async updateCompany(
    companyId: number,
    input: Record<string, unknown>,
    connection: QueryExecutor,
  ) {
    const entries = Object.entries(input).filter(([, value]) => value !== undefined)
    if (entries.length > 0)
      await connection.execute(
        `UPDATE companies SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`,
        [...entries.map(([, value]) => value), companyId] as DatabaseValue[],
      )
    return this.company(companyId, connection)
  }

  async sequences(companyId: number, connection: QueryExecutor = db) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT id, sequence_key, prefix, current_number, padding, reset_period,
              last_reset_key, created_at, updated_at
       FROM number_sequences WHERE company_id = ? ORDER BY sequence_key`,
      [companyId],
    )
    return rows
  }

  async upsertSequence(
    companyId: number,
    input: {
      sequence_key: string
      prefix: string
      padding: number
      reset_period: string
      current_number?: number
    },
    connection: QueryExecutor,
  ) {
    await connection.execute(
      `INSERT INTO number_sequences (
         company_id, sequence_key, prefix, current_number, padding, reset_period
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         prefix = VALUES(prefix), padding = VALUES(padding), reset_period = VALUES(reset_period),
         current_number = IF(? IS NULL, current_number, VALUES(current_number))`,
      [
        companyId,
        input.sequence_key,
        input.prefix,
        input.current_number ?? 0,
        input.padding,
        input.reset_period,
        input.current_number ?? null,
      ],
    )
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT id, sequence_key, prefix, current_number, padding, reset_period,
              last_reset_key, created_at, updated_at
       FROM number_sequences
       WHERE company_id = ? AND sequence_key = ? LIMIT 1`,
      [companyId, input.sequence_key],
    )
    return rows[0]
  }
}
