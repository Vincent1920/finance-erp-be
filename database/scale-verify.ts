import assert from 'node:assert/strict'
import { db } from '../config/database'
import { PayrollService } from '../services/PayrollService'
import { BankingService } from '../services/BankingService'
import { csvFile, pdfFile, type FileSnapshot } from '../services/ReportFileService'

/** Capacity smoke tests: intentionally limited to disposable integration schemas. */
export async function verifyScale(userId: number, bankId: number) {
  assert.match(String(process.env.DB_NAME), /^finora_verify_\d+_\d+$/)
  const timed = async (name: string, fn: () => Promise<void>) => {
    const start = performance.now()
    await fn()
    console.log(`PASS capacity ${name}: ${Math.round(performance.now() - start)} ms`)
  }
  await timed('payroll 1000 employees / server calculation / repeatability', async () => {
    await db.execute('INSERT INTO payroll_policies(company_id,effective_from,created_by) VALUES(1,?,?) ON DUPLICATE KEY UPDATE created_by=created_by', ['2026-02-01', userId])
    await db.query('INSERT INTO payroll_ter_rates(company_id,category,gross_from,gross_to,rate,effective_from) VALUES(1,\'A\',0,NULL,0.01,\'2026-02-01\')')
    const values = Array.from({ length: 1000 }, (_, i) => [1, `LOAD-${i}`, `Capacity employee ${i}`, '2026-01-01', 'TK/0', 'A', 6000000 + i * 1000, 500000, userId])
    await db.query('INSERT INTO payroll_employees(company_id,employee_number,name,hire_date,ptkp_status,ter_category,basic_salary,fixed_allowance,created_by) VALUES ?', [values])
    const payroll = new PayrollService()
    const run: any = await payroll.createRun(1, { period: '2026-02', pay_date: '2026-02-28' }, { userId })
    const id = Number(run.id ?? run.run?.id)
    assert.ok(id)
    await payroll.calculate(1, id)
    const totals = async () => (await db.query<any[]>('SELECT COUNT(*) n,SUM(take_home_pay) thp,SUM(employee_bpjs) bpjs FROM payroll_entries WHERE run_id=?', [id]))[0][0]
    const before = await totals()
    assert.equal(Number(before.n), 1000)
    assert.ok(Number(before.thp) > 0)
    await payroll.calculate(1, id)
    assert.deepEqual(await totals(), before)
  })
  await timed('CSV 100000 rows and multipage PDF 1000 rows', async () => {
    const snapshot: FileSnapshot = { title: 'Capacity verification', company: 'Isolated test', currency: 'IDR', period: '2026', columns: [['id', 'ID'], ['amount', 'Amount']], rows: Array.from({ length: 100000 }, (_, i) => ({ id: i + 1, amount: `${i}.25` })) }
    const csv = csvFile(snapshot)
    assert.equal(csv.toString().split('\r\n').length, 100002)
    assert.ok(csv.length < 64 * 1024 * 1024)
    const pdf = await pdfFile({ ...snapshot, rows: snapshot.rows.slice(0, 1000) })
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
    assert.ok(pdf.toString('latin1').includes('/Type /Pages'))
  })
  await timed('bank statement 1000 lines / suggestion query', async () => {
    const banking = new BankingService()
    await banking.create(1, { request_key: crypto.randomUUID(), bank_account_id: bankId, number: 'LOAD-BANK', date_from: '2026-12-20', date_to: '2026-12-20', opening_balance: 0, closing_balance: -1000, lines: Array.from({ length: 1000 }, (_, i) => ({ date: '2026-12-20', description: `Unmatched capacity ${i}`, reference: `LOAD-BANK-${i}`, debit: '1.00', credit: '0.00', balance: -(i + 1) })) }, { userId })
    const filter = { bank_account_id: bankId, date_from: '2026-12-20', date_to: '2026-12-20' }
    assert.equal((await banking.statements(1, filter)).length, 1000)
    assert.equal((await banking.suggestions(1, filter)).length, 0)
  })
}
