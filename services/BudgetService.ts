import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import type { z } from 'zod'
import { db } from '../config/database'
import { idempotentOperation } from './IdempotentOperation'
import { BusinessValidationService } from './BusinessValidationService'
import { AuditService } from './AuditService'
import type { PostingContext } from './PostingService'
import type { budgetSchema, budgetApprovalSchema } from '../validators/operations.validator'
import { ConflictError, NotFoundError } from '../utils/AppError'
export class BudgetService {
  async list(companyId: number) {
    const [rows] = await db.execute<RowDataPacket[]>(
      'SELECT * FROM budgets WHERE company_id=? ORDER BY fiscal_year DESC,version_number DESC',
      [companyId],
    )
    return rows
  }
  create(companyId: number, input: z.output<typeof budgetSchema>, context: PostingContext) {
    return idempotentOperation(
      companyId,
      input.request_key,
      'budget-create',
      input,
      async (connection) => {
        await connection.execute('SELECT id FROM companies WHERE id=? FOR UPDATE', [companyId])
        const [versions] = await connection.execute<RowDataPacket[]>(
            'SELECT COALESCE(MAX(version_number),0)+1 version FROM budgets WHERE company_id=? AND fiscal_year=?',
            [companyId, input.year],
          ),
          version = Number(versions[0]!.version)
        const number = `BUD-${input.year}-${String(version).padStart(3, '0')}`
        const [created] = await connection.execute<ResultSetHeader>(
          `INSERT INTO budgets(company_id,budget_number,name,fiscal_year,version_number,notes,status,created_by) VALUES(?,?,?,?,?,?,'draft',?)`,
          [companyId, number, input.name, input.year, version, input.notes, context.userId],
        )
        const validation = new BusinessValidationService()
        for (const line of input.lines) {
          await validation.ensureActiveReference(connection, {
            companyId,
            table: 'accounts',
            id: line.account_id,
            label: 'Akun anggaran',
            postingOnly: true,
          })
          const [accounts] = await connection.execute<RowDataPacket[]>(
            'SELECT account_type FROM accounts WHERE id=? AND company_id=?',
            [line.account_id, companyId],
          )
          if (
            !['expense', 'cogs', 'revenue', 'other_income', 'other_expense'].includes(
              String(accounts[0]?.account_type),
            )
          )
            throw new ConflictError('Anggaran operasional hanya menerima akun pendapatan dan beban')
          if (line.cost_center_id)
            await validation.ensureActiveReference(connection, {
              companyId,
              table: 'cost_centers',
              id: line.cost_center_id,
              label: 'Pusat biaya',
            })
          if (line.project_id)
            await validation.ensureActiveReference(connection, {
              companyId,
              table: 'projects',
              id: line.project_id,
              label: 'Proyek',
            })
          for (const [month, amount] of line.amounts.entries())
            await connection.execute(
              `INSERT INTO budget_lines(budget_id,account_id,month,cost_center_id,project_id,dimension_key,amount) VALUES(?,?,?,?,?,?,?)`,
              [
                created.insertId,
                line.account_id,
                month + 1,
                line.cost_center_id ?? null,
                line.project_id ?? null,
                `${line.cost_center_id ?? 0}:${line.project_id ?? 0}`,
                amount,
              ],
            )
        }
        await new AuditService().log(connection, {
          companyId,
          userId: context.userId,
          module: 'budgets',
          action: 'create',
          recordType: 'budget',
          recordId: created.insertId,
          recordNumber: number,
          newValue: input,
        })
        return { id: created.insertId, number, version, status: 'draft' }
      },
    )
  }
  approve(
    companyId: number,
    input: z.output<typeof budgetApprovalSchema>,
    context: PostingContext,
  ) {
    return idempotentOperation(
      companyId,
      input.request_key,
      'budget-approve',
      input,
      async (connection) => {
        const [rows] = await connection.execute<RowDataPacket[]>(
          'SELECT * FROM budgets WHERE id=? AND company_id=? FOR UPDATE',
          [input.id, companyId],
        )
        const budget = rows[0]
        if (!budget) throw new NotFoundError('Anggaran tidak ditemukan')
        if (budget.status !== 'draft') throw new ConflictError('Hanya draft dapat disetujui')
        await new BusinessValidationService().ensureIndependentApprover(
          connection,
          companyId,
          Number(budget.created_by),
          context.userId,
        )
        await connection.execute(
          `UPDATE budgets SET status='approved',approved_by=?,approved_at=NOW() WHERE id=? AND company_id=?`,
          [context.userId, input.id, companyId],
        )
        await new AuditService().log(connection, {
          companyId,
          userId: context.userId,
          module: 'budgets',
          action: 'approve',
          recordType: 'budget',
          recordId: input.id,
        })
        return { id: input.id, status: 'approved' }
      },
    )
  }
  async detail(companyId: number, id: number, asOf: string) {
    const [headers] = await db.execute<RowDataPacket[]>(
        `SELECT b.*,u.name creator_name,v.name approver_name FROM budgets b
         LEFT JOIN users u ON u.id=b.created_by AND u.company_id=b.company_id
         LEFT JOIN users v ON v.id=b.approved_by AND v.company_id=b.company_id
         WHERE b.id=? AND b.company_id=?`,
        [id, companyId],
      ),
      header = headers[0]
    if (!header) throw new NotFoundError('Anggaran tidak ditemukan')
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT bl.*,a.code account_code,a.name account_name,a.account_type,cc.name cost_center_name,p.name project_name,COALESCE((SELECT SUM(CASE WHEN a.normal_balance='credit' THEN jl.credit-jl.debit ELSE jl.debit-jl.credit END) FROM journal_lines jl JOIN journals j ON j.id=jl.journal_id WHERE j.company_id=? AND j.status IN ('posted','reversed') AND YEAR(j.journal_date)=? AND MONTH(j.journal_date)=bl.month AND j.journal_date<=? AND jl.account_id=bl.account_id AND jl.cost_center_id <=> bl.cost_center_id AND jl.project_id <=> bl.project_id),0) actual FROM budget_lines bl JOIN accounts a ON a.id=bl.account_id LEFT JOIN cost_centers cc ON cc.id=bl.cost_center_id LEFT JOIN projects p ON p.id=bl.project_id WHERE bl.budget_id=? ORDER BY a.code,bl.dimension_key,bl.month`,
      [companyId, header.fiscal_year, asOf, id],
    )
    const [unbudgeted] = await db.execute<RowDataPacket[]>(
      `SELECT a.code,a.name,SUM(CASE WHEN a.normal_balance='credit' THEN jl.credit-jl.debit ELSE jl.debit-jl.credit END) actual FROM journal_lines jl JOIN journals j ON j.id=jl.journal_id JOIN accounts a ON a.id=jl.account_id WHERE j.company_id=? AND j.status IN ('posted','reversed') AND YEAR(j.journal_date)=? AND j.journal_date<=? AND a.account_type IN('expense','cogs','revenue','other_income','other_expense') AND NOT EXISTS(SELECT 1 FROM budget_lines bl WHERE bl.budget_id=? AND bl.account_id=jl.account_id AND bl.month=MONTH(j.journal_date) AND bl.cost_center_id <=> jl.cost_center_id AND bl.project_id <=> jl.project_id) GROUP BY a.id,a.code,a.name`,
      [companyId, header.fiscal_year, asOf, id],
    )
    const [history] = await db.execute<RowDataPacket[]>(
      `SELECT l.id,l.action,l.user_id,l.created_at,u.name user_name FROM audit_logs l
       LEFT JOIN users u ON u.id=l.user_id AND u.company_id=l.company_id
       WHERE l.company_id=? AND l.record_type='budget' AND l.record_id=? ORDER BY l.created_at,l.id`,
      [companyId, id],
    )
    return { header, rows, unbudgeted, history }
  }
}
