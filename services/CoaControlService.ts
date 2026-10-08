import type { RowDataPacket } from 'mysql2/promise'
import type { QueryExecutor } from '../types/database'
import { ConflictError } from '../utils/AppError'

export const controlAccountSql = `SELECT account_id FROM account_mappings WHERE company_id=? AND mapping_key IN ('AR_CONTROL','AP_CONTROL','INVENTORY','INPUT_VAT','OUTPUT_VAT','WITHHOLDING_TAX')
 UNION SELECT receivable_account_id FROM customers WHERE company_id=? AND deleted_at IS NULL
 UNION SELECT payable_account_id FROM suppliers WHERE company_id=? AND deleted_at IS NULL
 UNION SELECT inventory_account_id FROM items WHERE company_id=? AND deleted_at IS NULL
 UNION SELECT input_tax_account_id FROM tax_codes WHERE company_id=?
 UNION SELECT output_tax_account_id FROM tax_codes WHERE company_id=?
 UNION SELECT pph21_payable_account_id FROM payroll_policies WHERE company_id=?`
export async function controlAccountIds(cx: QueryExecutor, companyId: number) {
  const [rows] = await cx.execute<RowDataPacket[]>(controlAccountSql, Array(7).fill(companyId))
  return new Set(rows.map(r => Number(r.account_id)).filter(Boolean))
}
export async function assertManualAccounts(cx: QueryExecutor, companyId: number, ids: number[]) {
  const controls = await controlAccountIds(cx, companyId)
  for (const id of new Set(ids)) {
    const [rows] = await cx.execute<RowDataPacket[]>('SELECT code,allow_manual_journal FROM accounts WHERE company_id=? AND id=?', [companyId,id])
    if (controls.has(id)) throw new ConflictError(`Akun kontrol ${rows[0]?.code ?? id} tidak menerima jurnal manual. Gunakan modul sumber atau saldo awal subledger.`)
    if (rows[0] && !rows[0].allow_manual_journal) throw new ConflictError(`Akun ${rows[0].code} tidak mengizinkan jurnal manual`)
  }
}
export async function assertGovernedChange(cx: QueryExecutor, companyId: number, approved = false) {
  // Serialize hierarchy edits, mapping updates and proposal approval per company.
  await cx.execute('SELECT id FROM companies WHERE id=? FOR UPDATE', [companyId])
  if (approved) return
  const [used] = await cx.execute<RowDataPacket[]>("SELECT id FROM journals WHERE company_id=? AND status IN ('posted','reversed') LIMIT 1", [companyId])
  if (used.length) throw new ConflictError('Perusahaan sudah bertransaksi. Ajukan perubahan dari Kendali COA untuk persetujuan pengguna lain.')
}
