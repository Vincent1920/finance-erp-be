import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'

import { db } from '../config/database'
import type { QueryExecutor } from '../types/database'
import { pagination } from '../utils/pagination'

export interface JournalRow extends RowDataPacket {
  id: number
  company_id: number
  journal_number: string
  journal_date: Date | string
  status: string
  source_type: string | null
  source_id: number | null
  reversal_journal_id: number | null
  original_journal_id: number | null
  currency: string
  exchange_rate: string | number
  version: number
}

export interface JournalLineRow extends RowDataPacket {
  id: number
  account_id: number
  debit: string | number
  credit: string | number
  cost_center_id: number | null
  project_id: number | null
}

export interface JournalLineWrite {
  accountId: number
  description?: string | null
  costCenterId?: number | null
  projectId?: number | null
  debit: string
  credit: string
  currencyDebit?: string
  currencyCredit?: string
  exchangeRate?: string
}

export interface JournalWrite {
  companyId: number
  number: string
  date: string
  reference?: string | null
  description: string
  currency: string
  exchangeRate: string
  sourceType?: string | null
  sourceId?: number | null
  status?: string
  userId: number
  totalDebit: string
  totalCredit: string
  originalJournalId?: number | null
  lines: JournalLineWrite[]
}

export class JournalRepository {
  async list(
    companyId: number,
    query: {
      page?: string
      limit?: string
      search?: string
      status?: string
      dateFrom?: string
      dateTo?: string
      sourceType?: string
    },
  ) {
    const { page, limit, offset } = pagination(query.page, query.limit)
    const conditions = ['j.company_id = ?']
    const values: Array<string | number> = [companyId]
    if (query.search) {
      conditions.push('(j.journal_number LIKE ? OR j.reference LIKE ? OR j.description LIKE ?)')
      const search = `%${query.search}%`
      values.push(search, search, search)
    }
    if (query.status) {
      conditions.push('j.status = ?')
      values.push(query.status)
    }
    if (query.dateFrom) {
      conditions.push('j.journal_date >= ?')
      values.push(query.dateFrom)
    }
    if (query.dateTo) {
      conditions.push('j.journal_date <= ?')
      values.push(query.dateTo)
    }
    if (query.sourceType) {
      conditions.push('j.source_type = ?')
      values.push(query.sourceType)
    }
    const where = conditions.join(' AND ')
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT
         j.*,
         creator.name AS created_by_name,
         approver.name AS approved_by_name,
         poster.name AS posted_by_name
       FROM journals j
       INNER JOIN users creator ON creator.id = j.created_by
       LEFT JOIN users approver ON approver.id = j.approved_by
       LEFT JOIN users poster ON poster.id = j.posted_by
       WHERE ${where}
       ORDER BY j.journal_date DESC, j.id DESC
       LIMIT ? OFFSET ?`,
      [...values, limit, offset],
    )
    const [countRows] = await db.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM journals j WHERE ${where}`,
      values,
    )
    return { rows, page, limit, total: Number(countRows[0]?.total ?? 0) }
  }

  async find(connection: QueryExecutor, id: number, companyId: number) {
    const [rows] = await connection.execute<JournalRow[]>(
      `SELECT
         j.*,
         creator.name AS created_by_name,
         submitter.name AS submitted_by_name,
         approver.name AS approved_by_name,
         rejecter.name AS rejected_by_name,
         poster.name AS posted_by_name,
         reverser.name AS reversed_by_name
       FROM journals j
       INNER JOIN users creator ON creator.id = j.created_by
       LEFT JOIN users submitter ON submitter.id = j.submitted_by
       LEFT JOIN users approver ON approver.id = j.approved_by
       LEFT JOIN users rejecter ON rejecter.id = j.rejected_by
       LEFT JOIN users poster ON poster.id = j.posted_by
       LEFT JOIN users reverser ON reverser.id = j.reversed_by
       WHERE j.id = ? AND j.company_id = ?
       LIMIT 1`,
      [id, companyId],
    )
    return rows[0] ?? null
  }

  async detail(id: number, companyId: number) {
    const journal = await this.find(db, id, companyId)
    if (!journal) return null
    const [lines] = await db.execute<RowDataPacket[]>(
      `SELECT
         jl.*,
         a.code AS account_code,
         a.name AS account_name,
         cc.code AS cost_center_code,
         cc.name AS cost_center_name,
         p.code AS project_code,
         p.name AS project_name
       FROM journal_lines jl
       INNER JOIN accounts a ON a.id = jl.account_id AND a.company_id = ?
       LEFT JOIN cost_centers cc ON cc.id = jl.cost_center_id AND cc.company_id = ?
       LEFT JOIN projects p ON p.id = jl.project_id AND p.company_id = ?
       WHERE jl.journal_id = ?
       ORDER BY jl.line_number, jl.id`,
      [companyId, companyId, companyId, id],
    )
    return { ...journal, lines }
  }

  async findForUpdate(connection: QueryExecutor, id: number, companyId: number) {
    const [rows] = await connection.execute<JournalRow[]>(
      `SELECT * FROM journals WHERE id = ? AND company_id = ? FOR UPDATE`,
      [id, companyId],
    )
    return rows[0] ?? null
  }

  async findPostedSource(
    connection: QueryExecutor,
    companyId: number,
    sourceType: string,
    sourceId: number,
  ) {
    const [rows] = await connection.execute<JournalRow[]>(
      `SELECT *
       FROM journals
       WHERE company_id = ? AND source_type = ? AND source_id = ?
         AND status IN ('posted', 'reversed')
       LIMIT 1
       FOR UPDATE`,
      [companyId, sourceType, sourceId],
    )
    return rows[0] ?? null
  }

  async lines(connection: QueryExecutor, id: number) {
    const [rows] = await connection.execute<JournalLineRow[]>(
      `SELECT * FROM journal_lines WHERE journal_id = ? ORDER BY line_number, id`,
      [id],
    )
    return rows
  }

  async period(connection: QueryExecutor, companyId: number, date: string) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT *
       FROM accounting_periods
       WHERE company_id = ? AND ? BETWEEN start_date AND end_date
       LIMIT 1
       FOR SHARE`,
      [companyId, date],
    )
    return rows[0] ?? null
  }

  async create(connection: QueryExecutor, input: JournalWrite) {
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO journals (
         company_id, journal_number, journal_date, reference, description,
         source_type, source_id, status, currency, exchange_rate,
         total_debit, total_credit, original_journal_id, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.companyId,
        input.number,
        input.date,
        input.reference ?? null,
        input.description,
        input.sourceType ?? null,
        input.sourceId ?? null,
        input.status ?? 'draft',
        input.currency,
        input.exchangeRate,
        input.totalDebit,
        input.totalCredit,
        input.originalJournalId ?? null,
        input.userId,
      ],
    )
    await this.insertLines(connection, result.insertId, input.lines)
    return result.insertId
  }

  async updateDraft(
    connection: QueryExecutor,
    id: number,
    input: Omit<
      JournalWrite,
      'companyId' | 'number' | 'sourceType' | 'sourceId' | 'status' | 'userId'
    >,
  ) {
    await connection.execute(
      `UPDATE journals
       SET journal_date = ?, reference = ?, description = ?, currency = ?, exchange_rate = ?,
           total_debit = ?, total_credit = ?, status = 'draft', rejected_by = NULL,
           rejected_at = NULL, rejection_reason = NULL, version = version + 1
       WHERE id = ?`,
      [
        input.date,
        input.reference ?? null,
        input.description,
        input.currency,
        input.exchangeRate,
        input.totalDebit,
        input.totalCredit,
        id,
      ],
    )
    await connection.execute('DELETE FROM journal_lines WHERE journal_id = ?', [id])
    await this.insertLines(connection, id, input.lines)
  }

  private async insertLines(
    connection: QueryExecutor,
    journalId: number,
    lines: JournalLineWrite[],
  ) {
    for (const [index, line] of lines.entries()) {
      await connection.execute(
        `INSERT INTO journal_lines (
           journal_id, line_number, account_id, description, cost_center_id, project_id,
           debit, credit, currency_debit, currency_credit, exchange_rate
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          journalId,
          index + 1,
          line.accountId,
          line.description ?? null,
          line.costCenterId ?? null,
          line.projectId ?? null,
          line.debit,
          line.credit,
          line.currencyDebit ?? line.debit,
          line.currencyCredit ?? line.credit,
          line.exchangeRate ?? '1.00000000',
        ],
      )
    }
  }

  async transition(
    connection: QueryExecutor,
    id: number,
    status: string,
    fields: Record<string, string | number | null>,
  ) {
    const allowedFields = new Set([
      'submitted_by',
      'submitted_at',
      'approved_by',
      'approved_at',
      'rejected_by',
      'rejected_at',
      'rejection_reason',
      'posted_by',
      'posted_at',
      'reversed_by',
      'reversed_at',
      'reversal_journal_id',
      'cancelled_by',
      'cancelled_at',
      'cancellation_reason',
    ])
    const entries = Object.entries(fields).filter(([field]) => allowedFields.has(field))
    const assignments = [
      'status = ?',
      'version = version + 1',
      ...entries.map(([field]) => `${field} = ?`),
    ]
    await connection.execute(`UPDATE journals SET ${assignments.join(', ')} WHERE id = ?`, [
      status,
      ...entries.map(([, value]) => value),
      id,
    ])
  }

  async removeDraft(connection: QueryExecutor, id: number) {
    await connection.execute('DELETE FROM journals WHERE id = ?', [id])
  }
}
