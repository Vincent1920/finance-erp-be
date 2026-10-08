import type { RowDataPacket } from 'mysql2/promise'
import type { QueryExecutor } from '../types/database'
import { AuditService } from './AuditService'
export async function prepareDirectPosting(connection: QueryExecutor, companyId: number, table: 'sales_invoices' | 'purchase_invoices' | 'journals', id: number, status: string, userId: number) {
  if (status !== 'draft') return false
  const [rows] = await connection.execute<RowDataPacket[]>('SELECT setting_value FROM settings WHERE company_id=? AND setting_key=?', [companyId, 'accounting.bypass_workflow'])
  if (rows[0]?.setting_value !== 'true') return false
  // Caller holds the document lock and executes the normal posting validations in this transaction.
  await connection.execute(`UPDATE ${table} SET status='approved' WHERE id=? AND company_id=? AND status='draft'`, [id, companyId])
  await new AuditService().log(connection, {companyId,userId,module:'accounting',action:'workflow_bypassed',recordType:table,recordId:id,oldValue:{status},newValue:{mode:'direct_post',policy:'accounting.bypass_workflow'}})
  return true
}
