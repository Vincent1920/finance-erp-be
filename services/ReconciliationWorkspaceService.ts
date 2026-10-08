import type { RowDataPacket } from 'mysql2/promise'

import { db, transaction } from '../config/database'
import { AuditService } from './AuditService'
import { NotFoundError, ValidationError } from '../utils/AppError'

export type ReconciliationType = 'ar' | 'ap' | 'inventory' | 'bank' | 'fixed_asset' | 'accumulated_depreciation' | 'payroll'
export type ReconciliationStatus = 'open' | 'in_review' | 'resolved' | 'accepted_variance'

export interface ReconciliationCaseInput {
  as_of_date: string
  reconciliation_type: ReconciliationType
  account_id: number
  general_ledger: number
  subledger: number
  difference: number
  status: ReconciliationStatus
  assigned_to?: number | null
  due_date?: string | null
  note?: string | null
}

interface Actor { userId: number; requestId?: string; ip?: string }

export class ReconciliationWorkspaceService {
  async cases(companyId: number, asOfDate: string) {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT c.*,u.name assigned_to_name,creator.name created_by_name,updater.name updated_by_name
         FROM reconciliation_cases c
         LEFT JOIN users u ON u.id=c.assigned_to
         JOIN users creator ON creator.id=c.created_by
         JOIN users updater ON updater.id=c.updated_by
        WHERE c.company_id=? AND c.as_of_date=?`,
      [companyId, asOfDate],
    )
    return rows
  }

  async detail(companyId: number, type: ReconciliationType, accountId: number, asOfDate: string) {
    const [accountRows, journals, sources, caseRows, users] = await Promise.all([
      db.execute<RowDataPacket[]>('SELECT id,code,name FROM accounts WHERE id=? AND company_id=? AND deleted_at IS NULL', [accountId, companyId]),
      db.execute<RowDataPacket[]>(
        `SELECT jl.id line_id,j.id journal_id,j.journal_number,j.journal_date,j.reference,j.description,
                j.source_type,j.source_id,j.status,jl.description line_description,jl.debit,jl.credit
           FROM journal_lines jl JOIN journals j ON j.id=jl.journal_id
          WHERE j.company_id=? AND jl.account_id=? AND j.status IN('posted','reversed') AND j.journal_date<=?
          ORDER BY j.journal_date DESC,j.id DESC,jl.id DESC LIMIT 500`,
        [companyId, accountId, asOfDate],
      ),
      this.sourceRows(companyId, type, accountId, asOfDate),
      db.execute<RowDataPacket[]>(
        `SELECT c.*,u.name assigned_to_name,creator.name created_by_name,updater.name updated_by_name
           FROM reconciliation_cases c LEFT JOIN users u ON u.id=c.assigned_to
           JOIN users creator ON creator.id=c.created_by JOIN users updater ON updater.id=c.updated_by
          WHERE c.company_id=? AND c.as_of_date=? AND c.reconciliation_type=? AND c.account_id=? LIMIT 1`,
        [companyId, asOfDate, type, accountId],
      ),
      db.execute<RowDataPacket[]>('SELECT id,name,email FROM users WHERE company_id=? AND status=\'active\' AND deleted_at IS NULL ORDER BY name', [companyId]),
    ])
    const account = accountRows[0][0]
    if (!account) throw new NotFoundError('Akun rekonsiliasi tidak ditemukan')
    const currentCase = caseRows[0][0] ?? null
    let activities: RowDataPacket[] = []
    if (currentCase) {
      const [rows] = await db.execute<RowDataPacket[]>(
        `SELECT a.*,u.name user_name FROM reconciliation_case_activities a JOIN users u ON u.id=a.user_id
          WHERE a.company_id=? AND a.case_id=? ORDER BY a.created_at DESC,a.id DESC`,
        [companyId, currentCase.id],
      )
      activities = rows
    }
    return { account, journals: journals[0], sources, case: currentCase, activities, users: users[0] }
  }

  async saveCase(companyId: number, input: ReconciliationCaseInput, actor: Actor) {
    return transaction(async (connection) => {
      const [accountRows] = await connection.execute<RowDataPacket[]>('SELECT id FROM accounts WHERE id=? AND company_id=? AND deleted_at IS NULL', [input.account_id, companyId])
      if (!accountRows[0]) throw new NotFoundError('Akun tidak ditemukan')
      if (input.assigned_to) {
        const [userRows] = await connection.execute<RowDataPacket[]>('SELECT id FROM users WHERE id=? AND company_id=? AND status=\'active\' AND deleted_at IS NULL', [input.assigned_to, companyId])
        if (!userRows[0]) throw new ValidationError('Penanggung jawab tidak valid atau sudah tidak aktif')
      }
      const [oldRows] = await connection.execute<RowDataPacket[]>(
        `SELECT * FROM reconciliation_cases WHERE company_id=? AND as_of_date=? AND reconciliation_type=? AND account_id=? FOR UPDATE`,
        [companyId, input.as_of_date, input.reconciliation_type, input.account_id],
      )
      const old = oldRows[0]
      const note = input.note?.trim() || null
      await connection.execute(
        `INSERT INTO reconciliation_cases(company_id,as_of_date,reconciliation_type,account_id,general_ledger_amount,subledger_amount,difference_amount,status,assigned_to,due_date,resolution_note,created_by,updated_by)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE general_ledger_amount=VALUES(general_ledger_amount),subledger_amount=VALUES(subledger_amount),difference_amount=VALUES(difference_amount),status=VALUES(status),assigned_to=VALUES(assigned_to),due_date=VALUES(due_date),
           resolution_note=VALUES(resolution_note),updated_by=VALUES(updated_by)`,
        [companyId, input.as_of_date, input.reconciliation_type, input.account_id, input.general_ledger, input.subledger, input.difference, input.status, input.assigned_to ?? null, input.due_date ?? null, note, actor.userId, actor.userId],
      )
      const [savedRows] = await connection.execute<RowDataPacket[]>(
        `SELECT * FROM reconciliation_cases WHERE company_id=? AND as_of_date=? AND reconciliation_type=? AND account_id=?`,
        [companyId, input.as_of_date, input.reconciliation_type, input.account_id],
      )
      const saved = savedRows[0]
      const action = !old ? 'created' : old.status !== input.status ? 'status_changed' : old.assigned_to !== (input.assigned_to ?? null) ? 'assigned' : note ? 'commented' : 'updated'
      await connection.execute(
        `INSERT INTO reconciliation_case_activities(company_id,case_id,action,previous_status,new_status,note,user_id) VALUES(?,?,?,?,?,?,?)`,
        [companyId, saved.id, action, old?.status ?? null, input.status, note, actor.userId],
      )
      await new AuditService().log(connection, {
        companyId, userId: actor.userId, module: 'reports', action: 'reconcile',
        recordType: 'reconciliation_case', recordId: Number(saved.id),
        recordNumber: `${input.as_of_date}/${input.reconciliation_type}/${input.account_id}`,
        oldValue: old ?? null, newValue: saved, requestId: actor.requestId, ip: actor.ip,
      })
      return saved
    })
  }

  private async sourceRows(companyId: number, type: ReconciliationType, accountId: number, asOfDate: string) {
    const query = this.sourceQuery(type)
    const [rows] = await db.execute<RowDataPacket[]>(query.sql, query.values(companyId, accountId, asOfDate))
    return rows
  }

  private sourceQuery(type: ReconciliationType): { sql: string; values: (companyId: number, accountId: number, asOfDate: string) => Array<string | number> } {
    if (type === 'ar') return {
      sql: `SELECT * FROM (
              SELECT si.invoice_date source_date,'sales_invoice' source_type,si.id source_id,si.invoice_number document_number,c.name party_name,si.status,si.base_grand_total amount
                FROM sales_invoices si JOIN customers c ON c.id=si.customer_id
               WHERE si.company_id=? AND si.control_account_id=? AND si.invoice_date<=? AND si.status IN('posted','partially_paid','paid')
              UNION ALL
              SELECT p.payment_date,'customer_payment',p.id,p.payment_number,c.name,p.status,-pa.base_amount
                FROM customer_payment_allocations pa JOIN customer_payments p ON p.id=pa.customer_payment_id
                JOIN sales_invoices si ON si.id=pa.sales_invoice_id JOIN customers c ON c.id=si.customer_id
               WHERE p.company_id=? AND si.control_account_id=? AND p.payment_date<=? AND p.status='posted'
              UNION ALL
              SELECT r.return_date,'sales_return',r.id,r.return_number,c.name,r.status,-r.base_grand_total
                FROM sales_returns r JOIN customers c ON c.id=r.customer_id JOIN sales_invoices si ON si.id=r.sales_invoice_id AND si.company_id=r.company_id
               WHERE r.company_id=? AND si.control_account_id=? AND r.return_date<=? AND r.status='posted'
            ) source_rows ORDER BY source_date DESC,source_id DESC LIMIT 500`,
      values: (c, a, d) => [c, a, d, c, a, d, c, a, d],
    }
    if (type === 'ap') return {
      sql: `SELECT * FROM (
              SELECT pi.invoice_date source_date,'purchase_invoice' source_type,pi.id source_id,pi.invoice_number document_number,s.name party_name,pi.status,pi.base_grand_total amount
                FROM purchase_invoices pi JOIN suppliers s ON s.id=pi.supplier_id
               WHERE pi.company_id=? AND pi.control_account_id=? AND pi.invoice_date<=? AND pi.status IN('posted','partially_paid','paid')
              UNION ALL
              SELECT p.payment_date,'supplier_payment',p.id,p.payment_number,s.name,p.status,-pa.base_amount
                FROM supplier_payment_allocations pa JOIN supplier_payments p ON p.id=pa.supplier_payment_id
                JOIN purchase_invoices pi ON pi.id=pa.purchase_invoice_id JOIN suppliers s ON s.id=pi.supplier_id
               WHERE p.company_id=? AND pi.control_account_id=? AND p.payment_date<=? AND p.status='posted'
              UNION ALL
              SELECT r.return_date,'purchase_return',r.id,r.return_number,s.name,r.status,-r.base_grand_total
                FROM purchase_returns r JOIN suppliers s ON s.id=r.supplier_id JOIN purchase_invoices pi ON pi.id=r.purchase_invoice_id AND pi.company_id=r.company_id
               WHERE r.company_id=? AND pi.control_account_id=? AND r.return_date<=? AND r.status='posted'
            ) source_rows ORDER BY source_date DESC,source_id DESC LIMIT 500`,
      values: (c, a, d) => [c, a, d, c, a, d, c, a, d],
    }
    if (type === 'inventory') return {
      sql: `SELECT im.movement_date source_date,im.transaction_type source_type,im.transaction_id source_id,im.transaction_number document_number,
                   CONCAT(i.sku,' · ',i.name) party_name,'posted' status,CASE WHEN im.quantity_in>0 THEN im.total_cost ELSE -im.total_cost END amount
              FROM inventory_movements im JOIN items i ON i.id=im.item_id
             WHERE im.company_id=? AND i.inventory_account_id=? AND im.movement_date<=?
             ORDER BY im.movement_date DESC,im.id DESC LIMIT 500`, values: (c, a, d) => [c, a, d],
    }
    if (type === 'bank') return {
      sql: `SELECT l.transaction_date source_date,'bank_statement' source_type,s.id source_id,s.statement_number document_number,l.description party_name,l.reconciliation_status status,(l.debit-l.credit) amount
              FROM bank_statement_lines l JOIN bank_statements s ON s.id=l.bank_statement_id JOIN bank_accounts b ON b.id=s.bank_account_id
             WHERE s.company_id=? AND b.gl_account_id=? AND l.transaction_date<=?
             ORDER BY l.transaction_date DESC,l.id DESC LIMIT 500`, values: (c, a, d) => [c, a, d],
    }
    if (type === 'fixed_asset') return {
      sql: `SELECT fa.in_service_date source_date,'fixed_asset' source_type,fa.id source_id,fa.asset_code document_number,fa.asset_name party_name,fa.status,fa.purchase_cost amount
              FROM fixed_assets fa WHERE fa.company_id=? AND fa.asset_account_id=? AND fa.in_service_date<=? AND fa.deleted_at IS NULL AND fa.status<>'draft'
             ORDER BY fa.in_service_date DESC,fa.id DESC LIMIT 500`, values: (c, a, d) => [c, a, d],
    }
    if (type === 'accumulated_depreciation') return {
      sql: `SELECT ad.depreciation_date source_date,'asset_depreciation' source_type,ad.id source_id,fa.asset_code document_number,fa.asset_name party_name,ad.status,ad.depreciation_amount amount
              FROM asset_depreciations ad JOIN fixed_assets fa ON fa.id=ad.fixed_asset_id
             WHERE ad.company_id=? AND fa.accumulated_depreciation_account_id=? AND ad.depreciation_date<=? AND ad.status='posted'
             ORDER BY ad.depreciation_date DESC,ad.id DESC LIMIT 500`, values: (c, a, d) => [c, a, d],
    }
    return {
      sql: `SELECT pr.date_to source_date,'payroll' source_type,pr.id source_id,pr.number document_number,pr.period party_name,pr.status,pr.total_take_home_pay amount
              FROM payroll_runs pr JOIN payroll_policies pp ON pp.id=pr.policy_id
             WHERE pr.company_id=? AND pp.payroll_payable_account_id=? AND pr.date_to<=? AND pr.status='posted'
             ORDER BY pr.date_to DESC,pr.id DESC LIMIT 500`, values: (c, a, d) => [c, a, d],
    }
  }
}
