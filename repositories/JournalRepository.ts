import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'

import { JOURNAL_STATUS } from '../constants/accounting'

interface JournalRow extends RowDataPacket {
  journal_date: Date | string
  status: string
}

interface JournalLineRow extends RowDataPacket {
  account_id: number
  debit: number
  credit: number
}

interface AccountingPeriodRow extends RowDataPacket {
  status: string
}

export class JournalRepository {
  async findForUpdate(connection: PoolConnection, id: number, companyId: number) {
    const [rows] = await connection.execute<JournalRow[]>(
      `SELECT *
       FROM journals
       WHERE id = ? AND company_id = ?
       FOR UPDATE`,
      [id, companyId],
    )

    return rows[0] ?? null
  }

  async lines(connection: PoolConnection, id: number) {
    const [rows] = await connection.execute<JournalLineRow[]>(
      `SELECT *
       FROM journal_lines
       WHERE journal_id = ?`,
      [id],
    )

    return rows
  }

  async period(connection: PoolConnection, companyId: number, date: string) {
    const [rows] = await connection.execute<AccountingPeriodRow[]>(
      `SELECT *
       FROM accounting_periods
       WHERE company_id = ?
         AND ? BETWEEN start_date AND end_date
       LIMIT 1`,
      [companyId, date],
    )

    return rows[0] ?? null
  }

  async create(
    connection: PoolConnection,
    input: {
      companyId: number
      number: string
      date: string
      reference?: string
      description: string
      userId: number
      lines: { accountId: number; description?: string; debit: number; credit: number }[]
    },
  ) {
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO journals (
         company_id, journal_number, journal_date, reference, description, status, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.companyId,
        input.number,
        input.date,
        input.reference ?? null,
        input.description,
        'draft',
        input.userId,
      ],
    )
    for (const line of input.lines) {
      await connection.execute(
        `INSERT INTO journal_lines (journal_id, account_id, description, debit, credit)
         VALUES (?, ?, ?, ?, ?)`,
        [result.insertId, line.accountId, line.description ?? null, line.debit, line.credit],
      )
    }

    return result.insertId
  }

  async markAsPosted(connection: PoolConnection, journalId: number, userId: number) {
    await connection.execute(
      `UPDATE journals
       SET status = ?, posted_by = ?, posted_at = NOW()
       WHERE id = ? AND status <> ?`,
      [JOURNAL_STATUS.POSTED, userId, journalId, JOURNAL_STATUS.POSTED],
    )
  }

  async createPostingAuditLog(
    connection: PoolConnection,
    journalId: number,
    companyId: number,
    userId: number,
  ) {
    await connection.execute(
      `INSERT INTO audit_logs (
         company_id, user_id, module, action, record_type, record_id, new_value
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        companyId,
        userId,
        'accounting',
        'post',
        'journal',
        journalId,
        JSON.stringify({ status: JOURNAL_STATUS.POSTED }),
      ],
    )
  }
}
