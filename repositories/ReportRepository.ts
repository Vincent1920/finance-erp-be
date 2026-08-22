import type { RowDataPacket } from 'mysql2'

import { db } from '../config/database'

export interface TrialBalanceRow {
  id: number
  code: string
  name: string
  movementDebit: number
  movementCredit: number
  endingDebit: number
  endingCredit: number
}

interface TrialBalanceDbRow extends RowDataPacket {
  id: number
  code: string
  name: string
  movement_debit: number
  movement_credit: number
  ending_debit: number
  ending_credit: number
}

export class ReportRepository {
  async trialBalance(companyId: number): Promise<TrialBalanceRow[]> {
    const [rows] = await db.execute<TrialBalanceDbRow[]>(
      `SELECT
         a.id,
         a.code,
         a.name,
         COALESCE(SUM(jl.debit), 0) AS movement_debit,
         COALESCE(SUM(jl.credit), 0) AS movement_credit,
         CASE
           WHEN a.normal_balance = 'debit'
             THEN GREATEST(COALESCE(SUM(jl.debit - jl.credit), 0), 0)
           ELSE 0
         END AS ending_debit,
         CASE
           WHEN a.normal_balance = 'credit'
             THEN GREATEST(COALESCE(SUM(jl.credit - jl.debit), 0), 0)
           ELSE 0
         END AS ending_credit
       FROM accounts a
       LEFT JOIN journals j
         ON j.company_id = a.company_id AND j.status = 'posted'
       LEFT JOIN journal_lines jl
         ON jl.journal_id = j.id AND jl.account_id = a.id
       WHERE a.company_id = ?
       GROUP BY a.id, a.code, a.name, a.normal_balance
       ORDER BY a.code`,
      [companyId],
    )

    return rows.map((row) => ({
      id: Number(row.id),
      code: String(row.code),
      name: String(row.name),
      movementDebit: Number(row.movement_debit),
      movementCredit: Number(row.movement_credit),
      endingDebit: Number(row.ending_debit),
      endingCredit: Number(row.ending_credit),
    }))
  }
}
