import { db } from '../config/database'
import { PayrollService } from '../services/PayrollService'

const [users] = await db.query<any[]>(`SELECT id,company_id FROM users WHERE status='active' AND deleted_at IS NULL ORDER BY id LIMIT 1`)
const user = users[0]
if (!user) throw new Error('Pengguna demo tidak tersedia')
const service = new PayrollService()
const [runs] = await db.query<any[]>(`SELECT id FROM payroll_runs WHERE company_id=? AND period='2026-09'`, [user.company_id])
let id = Number(runs[0]?.id ?? 0)
if (!id) {
  const created = await service.createRun(user.company_id, { period: '2026-09', pay_date: '2026-09-28', notes: 'Contoh payroll September 2026' }, { userId: user.id })
  id = Number(created.run.id)
  await db.query(`UPDATE payroll_entries e JOIN payroll_employees p ON p.id=e.employee_id SET
    e.variable_allowance=CASE p.employee_number WHEN 'EMP-001' THEN 750000 WHEN 'EMP-002' THEN 1250000 ELSE 350000 END,
    e.overtime=CASE p.employee_number WHEN 'EMP-003' THEN 625000 ELSE 0 END,
    e.bonus=CASE p.employee_number WHEN 'EMP-002' THEN 1000000 ELSE 0 END,
    e.absence_deduction=CASE p.employee_number WHEN 'EMP-003' THEN 150000 ELSE 0 END,
    e.loan_deduction=CASE p.employee_number WHEN 'EMP-001' THEN 500000 ELSE 0 END
    WHERE e.run_id=?`, [id])
}
await service.calculate(user.company_id, id)
console.log(`Payroll dummy siap: ${id}`)
await db.end()
