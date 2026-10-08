import { db, transaction } from '../config/database'
import { env } from '../config/env'
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import { randomUUID } from 'node:crypto'
import { OpeningBalanceService } from '../services/OpeningBalanceService'
import { JournalService } from '../services/JournalService'
import { EquityService } from '../services/EquityService'
import { StockOperationService } from '../services/StockOperationService'
import { SettlementService } from '../services/SettlementService'
import { PurchaseReturnService } from '../services/PurchaseReturnService'
import { PayrollService } from '../services/PayrollService'
import { FixedAssetService } from '../services/FixedAssetService'
import { AccountingScheduleService } from '../services/AccountingScheduleService'
import { RecurringJournalService } from '../services/RecurringJournalService'
import { BudgetService } from '../services/BudgetService'
import { BankingService } from '../services/BankingService'
import { shareholderSchema, equityTransactionSchema } from '../validators/equity.validator'
import {
  stockOperationSchema,
  settlementSchema,
  purchaseReturnSchema,
  budgetSchema,
  bankMatchingRuleSchema,
  bankImportMappingSchema,
  statementSchema,
} from '../validators/operations.validator'
import { payrollEmployeeSchema, payrollPolicySchema } from '../validators/payroll.validator'
import { accountingScheduleSchema } from '../validators/accounting-schedule.validator'
import { recurringJournalSchema } from '../validators/recurring-journal.validator'
import { hashPassword } from '../utils/password'

if (env.APP_ENV !== 'development') throw new Error('Development only')
const [companies] = await db.query<RowDataPacket[]>('SELECT id,name FROM companies')
if (companies.length !== 1 || companies[0]?.name !== 'PT Finora Indonesia')
  throw new Error('Demo company guard')
const cid = 1,
  key = () => randomUUID(),
  date = '2026-10-03'
const [users] = await db.execute<RowDataPacket[]>(
  'SELECT id FROM users WHERE company_id=1 AND email=?',
  ['demo.admin@finora.local'],
)
const actor = { userId: Number(users[0]!.id) }
await db.execute(
  `INSERT INTO users(company_id,name,email,password,status) VALUES(1,'Demo Finance Reviewer','demo.reviewer@finora.local',?,'active') ON DUPLICATE KEY UPDATE status='active'`,
  [await hashPassword('DemoFinance2026!')],
)
const [reviewers] = await db.execute<RowDataPacket[]>('SELECT id FROM users WHERE email=?', [
  'demo.reviewer@finora.local',
])
const checker = { userId: Number(reviewers[0]!.id) }
await db.execute(
  "INSERT IGNORE INTO user_roles(user_id,role_id) SELECT ?,id FROM roles WHERE company_id=1 AND slug='super-admin'",
  [checker.userId],
)
const [accountRows] = await db.query<RowDataPacket[]>(
  'SELECT id,code FROM accounts WHERE company_id=1',
)
const accounts: Record<string, number> = Object.fromEntries(
  accountRows.map((a) => [a.code, Number(a.id)]),
)
for (const [code, name, type, normal, parent] of [
  ['1131', 'Piutang Pegawai', 'asset', 'debit', '1120'],
  ['1160', 'Biaya Dibayar di Muka', 'asset', 'debit', '1100'],
  ['2301', 'Utang Gaji', 'liability', 'credit', '2100'],
  ['2302', 'Utang BPJS', 'liability', 'credit', '2100'],
  ['2303', 'Utang PPh 21', 'liability', 'credit', '2100'],
  ['2304', 'Utang Potongan Pegawai', 'liability', 'credit', '2100'],
  ['2305', 'Utang Akrual', 'liability', 'credit', '2100'],
  ['2306', 'Utang Dividen', 'liability', 'credit', '2100'],
  ['6110', 'Beban BPJS Perusahaan', 'expense', 'debit', '6000'],
]) {
  await db.execute(
    `INSERT INTO accounts(company_id,code,name,account_type,normal_balance,parent_id,level,is_posting,is_active,is_header) VALUES(1,?,?,?,?,?,2,TRUE,TRUE,FALSE) ON DUPLICATE KEY UPDATE is_active=TRUE`,
    [code, name, type, normal, accounts[parent!]!],
  )
  await db.execute(
    'UPDATE accounts child JOIN accounts parent ON parent.id=child.parent_id SET child.level=parent.level+1 WHERE child.company_id=1 AND child.code=?',
    [code],
  )
  const [a] = await db.execute<RowDataPacket[]>(
    'SELECT id FROM accounts WHERE company_id=1 AND code=?',
    [code],
  )
  accounts[code!] = Number(a[0]!.id)
}
for (const [mapping, code] of [
  ['PAID_IN_CAPITAL', '3101'],
  ['DIVIDENDS_PAYABLE', '2306'],
])
  await db.execute(
    `INSERT INTO account_mappings(company_id,mapping_key,account_id) VALUES(1,?,?) ON DUPLICATE KEY UPDATE account_id=VALUES(account_id)`,
    [mapping, accounts[code!]!],
  )
const [items] = await db.query<RowDataPacket[]>(
  "SELECT id,unit_id,sku FROM items WHERE company_id=1 AND item_type='inventory' ORDER BY sku",
)
const [warehouses] = await db.query<RowDataPacket[]>(
  'SELECT id FROM warehouses WHERE company_id=1 ORDER BY code',
)
const [banks] = await db.query<RowDataPacket[]>(
  'SELECT id,code,gl_account_id FROM bank_accounts WHERE company_id=1 ORDER BY code',
)
const bank = banks.find((b) => b.code === 'BANK-DEMO-BCA')!
const journals = new JournalService(),
  results: Array<{ feature: string; status: string; detail: unknown }> = []
async function stage(feature: string, work: () => Promise<unknown>) {
  try {
    const detail = await work()
    results.push({ feature, status: 'PASS', detail })
    console.log('PASS', feature)
  } catch (e) {
    results.push({ feature, status: 'FAIL', detail: e instanceof Error ? e.message : String(e) })
    console.log('FAIL', feature, results.at(-1)!.detail)
  }
  await Bun.write('storage/demo-complete-results.json', JSON.stringify(results, null, 2))
}
async function postJournal(id: number) {
  const j = await journals.get(id, cid)
  if (['draft', 'rejected'].includes(j.status)) await journals.submit(id, cid, actor)
  const current = await journals.get(id, cid)
  if (current.status === 'pending_approval') await journals.approve(id, cid, checker)
  if ((await journals.get(id, cid)).status === 'approved') await journals.post(id, cid, actor)
}
async function manual(
  reference: string,
  day: string,
  lines: Array<{ accountId: number; debit: number; credit: number }>,
) {
  const [old] = await db.execute<RowDataPacket[]>(
    'SELECT id FROM journals WHERE company_id=1 AND reference=?',
    [reference],
  )
  if (old[0]) {
    const id = Number(old[0].id)
    await postJournal(id)
    return id
  }
  const j = await journals.create(
    cid,
    {
      request_key: key(),
      journal_date: day,
      description: reference,
      reference,
      currency: 'IDR',
      exchange_rate: '1',
      lines: lines.map((l) => ({ ...l, debit: String(l.debit), credit: String(l.credit) })),
    },
    actor,
  )
  await postJournal(j.id)
  return j.id
}
try {
  await stage('Saldo awal GL, stok, aset dan modal', async () => {
    const opening = new OpeningBalanceService(),
      [b] = await db.query<RowDataPacket[]>(
        "SELECT * FROM opening_balance_batches WHERE company_id=1 AND batch_number='OPEN-DEMO-GL-2026'",
      )
    if (!b[0]?.journal_id) {
      const [cost] = await db.query<RowDataPacket[]>(
        "SELECT SUM(total_cost) amount FROM inventory_movements WHERE company_id=1 AND transaction_type='opening_balance'",
      )
      const stock = Number(cost[0]!.amount),
        capital = 400000000 + stock
      await transaction(async (c) => {
        await c.execute(
          'UPDATE opening_balance_lines SET debit=?,amount=? WHERE opening_balance_batch_id=? AND account_id=?',
          [stock, stock, b[0]!.id, accounts['1140']!],
        )
        await c.execute(
          'UPDATE opening_balance_lines SET credit=?,amount=? WHERE opening_balance_batch_id=? AND account_id=?',
          [capital, capital, b[0]!.id, accounts['3101']!],
        )
        await c.execute(
          'UPDATE opening_balance_batches SET total_debit=?,total_credit=? WHERE id=?',
          [capital, capital, b[0]!.id],
        )
      })
    }
    const prepared = await opening.prepareJournal(cid, Number(b[0]!.id), actor)
    await postJournal(prepared.id)
    return { batchId: b[0]!.id, journalId: prepared.id }
  })
  await stage('Pemegang saham dan laporan ekuitas', async () => {
    const equity = new EquityService(),
      [opening] = await db.query<RowDataPacket[]>(
        "SELECT journal_id,total_credit FROM opening_balance_batches WHERE company_id=1 AND batch_number='OPEN-DEMO-GL-2026'",
      )
    const capital = Number(opening[0]!.total_credit)
    for (const [code, name, ratio] of [
      ['SH-DEMO-01', 'Rina Prasetyo (Dummy)', 60],
      ['SH-DEMO-02', 'Adi Wibowo (Dummy)', 40],
    ] as const) {
      const [existing] = await db.execute<RowDataPacket[]>(
        'SELECT id FROM shareholders WHERE company_id=1 AND code=?',
        [code],
      )
      const holder =
        existing[0] ??
        (await equity.createShareholder(
          cid,
          shareholderSchema.parse({
            code,
            name,
            notes: 'Identitas fiktif untuk pengujian',
            holding: {
              effective_date: '2026-01-01',
              shares: ratio,
              nominal_value: capital / 100,
              reason: 'Alokasi modal dummy',
            },
          }),
          actor,
        ))
      const reference = `DEMO-OPEN-${code}`,
        [allocated] = await db.execute<RowDataPacket[]>(
          'SELECT id FROM equity_transactions WHERE company_id=1 AND reference=?',
          [reference],
        )
      if (!allocated[0])
        await equity.createTransaction(
          cid,
          equityTransactionSchema.parse({
            request_key: key(),
            shareholder_id: holder.id,
            transaction_date: '2026-01-01',
            transaction_type: 'opening_detail',
            amount: (capital * ratio) / 100,
            journal_id: opening[0]!.journal_id,
            reference,
          }),
          actor,
        )
    }
    return equity.report(cid, '2026-01-01', '2026-10-31')
  })
  await stage('Pelunasan AR/AP, biaya kartu dan retur pembelian', async () => {
    const settlement = new SettlementService()
    for (const sales of [true, false]) {
      const type = sales ? 'sales' : 'purchase',
        party = sales ? 'customer' : 'supplier'
      const [paid] = await db.execute<RowDataPacket[]>(
        `SELECT id FROM ${party}_payments WHERE company_id=1 AND reference='DEMO-PAY-${type}'`,
      )
      if (paid[0]) continue
      const [invoice] = await db.query<RowDataPacket[]>(
        `SELECT id,invoice_date,outstanding_amount FROM ${type}_invoices WHERE company_id=1 AND status='posted' AND outstanding_amount>10000 ORDER BY id LIMIT 1`,
      )
      if (!invoice[0]) throw new Error('Posted invoice missing')
      await settlement.post(
        cid,
        sales,
        settlementSchema.parse({
          request_key: key(),
          date,
          cash_account_id: accounts['1102'],
          bank_account_id: bank.id,
          payment_method: sales ? 'card' : 'bank_transfer',
          invoice_id: invoice[0].id,
          amount: Number(invoice[0].outstanding_amount) / 2,
          processing_fee_amount: sales ? 20000 : 5000,
          processing_fee_account_id: accounts['8101'],
          reference: `DEMO-PAY-${type}`,
        }),
        actor,
      )
    }
    const [returned] = await db.query<RowDataPacket[]>(
      "SELECT id FROM purchase_returns WHERE company_id=1 AND reference='DEMO-RETURN-PURCHASE'",
    )
    if (!returned[0]) {
      const [line] = await db.query<RowDataPacket[]>(
        "SELECT l.id,i.id invoice_id FROM purchase_invoice_lines l JOIN purchase_invoices i ON i.id=l.purchase_invoice_id WHERE i.company_id=1 AND i.status IN('posted','partially_paid') AND l.quantity>=1 ORDER BY i.id,l.id LIMIT 1",
      )
      await new PurchaseReturnService().post(
        cid,
        purchaseReturnSchema.parse({
          request_key: key(),
          date,
          invoice_id: line[0]!.invoice_id,
          return_stock: true,
          reason: 'Contoh retur satu unit barang rusak',
          reference: 'DEMO-RETURN-PURCHASE',
          lines: [{ invoice_line_id: line[0]!.id, quantity: 1 }],
        }),
        actor,
      )
    }
    return { partialPayments: 2, purchaseReturn: 1 }
  })
  await stage('Transfer dan penyesuaian stok', async () => {
    const stock = new StockOperationService()
    for (const transfer of [true, false]) {
      const table = transfer ? 'stock_transfers' : 'stock_adjustments',
        reference = `DEMO-STOCK-${transfer ? 'TRANSFER' : 'ADJUSTMENT'}`
      const [old] = await db.execute<RowDataPacket[]>(
        `SELECT id FROM ${table} WHERE company_id=1 AND reference=?`,
        [reference],
      )
      if (old[0]) continue
      const [balance] = await db.execute<RowDataPacket[]>(
        'SELECT quantity FROM inventory_balances WHERE company_id=1 AND item_id=? AND warehouse_id=?',
        [items[0]!.id, warehouses[0]!.id],
      )
      await stock.post(
        cid,
        transfer,
        stockOperationSchema.parse({
          request_key: key(),
          date,
          warehouse_id: warehouses[0]!.id,
          to_warehouse_id: transfer ? warehouses[1]!.id : undefined,
          reference,
          reason: 'Contoh operasional gudang',
          lines: transfer
            ? [{ item_id: items[0]!.id, unit_id: items[0]!.unit_id, quantity: 1 }]
            : [
                {
                  item_id: items[0]!.id,
                  unit_id: items[0]!.unit_id,
                  actual_quantity: Number(balance[0]!.quantity) - 1,
                  gain_loss_account_id: accounts['8103'],
                },
              ],
        }),
        actor,
      )
    }
    return { transfer: 1, adjustment: 1 }
  })
  await stage('Koreksi contoh jurnal penyusutan manual ganda', async () => {
    const [old] = await db.execute<RowDataPacket[]>(
      "SELECT id,status FROM journals WHERE company_id=1 AND reference='JRN-DEMO-010'",
    )
    if (old[0]?.status === 'posted')
      await journals.reverse(
        Number(old[0].id),
        cid,
        '2026-09-05',
        'Koreksi data dummy: penyusutan dicatat melalui register aset',
        actor,
      )
    return { corrected: true }
  })
  await stage('Penyusutan 5 aset tetap', async () => {
    const assets = await new FixedAssetService().list(cid, '2026-09-30')
    for (const asset of assets as any[]) {
      for (let month = 1; month <= 9; month++) {
        const day = `2026-${String(month).padStart(2, '0')}-${new Date(Date.UTC(2026, month, 0)).getUTCDate()}`
        const [old] = await db.execute<RowDataPacket[]>(
          'SELECT id FROM asset_depreciations WHERE fixed_asset_id=? AND depreciation_date=? AND status=?',
          [asset.id, day, 'posted'],
        )
        if (!old[0])
          await new FixedAssetService().depreciate(
            cid,
            { request_key: key(), asset_id: Number(asset.id), date: day },
            actor,
          )
      }
    }
    return { assets: assets.length }
  })
  await stage('Akrual, amortisasi, pembalikan dan aktual vs estimasi', async () => {
    const schedule = new AccountingScheduleService()
    for (const type of ['accrual', 'prepayment'] as const) {
      const ref = `DEMO-SCHEDULE-${type}`,
        [old] = await db.execute<RowDataPacket[]>(
          'SELECT id FROM accounting_schedules WHERE company_id=1 AND reference=?',
          [ref],
        )
      if (!old[0]) {
        if (type === 'prepayment')
          await manual('DEMO-PREPAID-RENT', '2026-09-01', [
            { accountId: accounts['1160']!, debit: 12000000, credit: 0 },
            { accountId: accounts['1102']!, debit: 0, credit: 12000000 },
          ])
        await schedule.create(
          cid,
          accountingScheduleSchema.parse({
            schedule_type: type,
            name: type === 'accrual' ? 'Akrual listrik demo' : 'Amortisasi sewa demo',
            reference: ref,
            start_date: '2026-09-30',
            periods_count: type === 'accrual' ? 3 : 12,
            total_estimated_amount: type === 'accrual' ? 3000000 : 12000000,
            pnl_account_id: accounts[type === 'accrual' ? '6103' : '6102'],
            balance_sheet_account_id: accounts[type === 'accrual' ? '2305' : '1160'],
            auto_reverse: type === 'accrual',
            auto_submit: true,
            save_as_template: true,
            template_name: ref,
          }),
          actor,
        )
      }
    }
    const [entries] = await db.query<RowDataPacket[]>(
      "SELECT e.* FROM accounting_schedule_entries e JOIN accounting_schedules s ON s.id=e.schedule_id WHERE e.company_id=1 AND s.reference LIKE 'DEMO-SCHEDULE-%' AND e.period_number=1",
    )
    for (const e of entries) {
      const generated = e.recognition_journal_id
        ? { journalId: Number(e.recognition_journal_id) }
        : await schedule.generate(cid, Number(e.id), actor)
      await postJournal(generated.journalId)
      if (String(e.status) !== 'reconciled')
        await schedule.reconcile(
          cid,
          Number(e.id),
          {
            actual_amount: Number(e.estimated_amount) + 50000,
            actual_reference: 'Contoh tagihan aktual dummy',
          },
          actor,
        )
    }
    const reversed = await schedule.processReversals(cid, '2026-10-01', actor)
    const [reversals] = await db.query<RowDataPacket[]>(
      'SELECT reversal_journal_id FROM accounting_schedule_entries WHERE company_id=1 AND reversal_journal_id IS NOT NULL',
    )
    for (const r of reversals) await postJournal(Number(r.reversal_journal_id))
    return { recognitions: entries.length, reversed }
  })
  await stage('Jurnal berulang', async () => {
    const recurring = new RecurringJournalService(),
      [old] = await db.query<RowDataPacket[]>(
        "SELECT id FROM recurring_journals WHERE company_id=1 AND reference='DEMO-RECURRING'",
      )
    if (!old[0])
      await recurring.create(
        cid,
        recurringJournalSchema.parse({
          name: 'Biaya internet bulanan demo',
          reference: 'DEMO-RECURRING',
          frequency: 'monthly',
          start_date: '2026-10-01',
          end_date: '2026-12-01',
          auto_submit: true,
          lines: [
            { accountId: accounts['6104'], debit: 750000, credit: 0 },
            { accountId: accounts['1102'], debit: 0, credit: 750000 },
          ],
        }),
        actor,
      )
    const generated = await recurring.generateDue(cid, date, actor)
    if (generated.failed.length) throw new Error(JSON.stringify(generated.failed))
    const [runs] = await db.query<RowDataPacket[]>(
      'SELECT r.generated_journal_id AS journal_id FROM recurring_journal_runs r JOIN recurring_journals j ON j.id=r.recurring_journal_id WHERE j.company_id=1',
    )
    for (const r of runs) await postJournal(Number(r.journal_id))
    return generated
  })
  await stage('Anggaran dan perbandingan aktual', async () => {
    const budget = new BudgetService(),
      [old] = await db.query<RowDataPacket[]>(
        "SELECT id,status FROM budgets WHERE company_id=1 AND name='Anggaran Operasional Demo 2026'",
      )
    const b =
      old[0] ??
      (await budget.create(
        cid,
        budgetSchema.parse({
          request_key: key(),
          name: 'Anggaran Operasional Demo 2026',
          year: 2026,
          lines: ['4101', '5101', '6101', '6102', '6103', '6104', '6110', '8101'].map((code) => ({
            account_id: accounts[code],
            amounts: Array(12).fill(
              code === '4101' ? 100000000 : code === '6101' ? 45000000 : 10000000,
            ),
          })),
        }),
        actor,
      ))
    if (!old[0] || old[0].status === 'draft')
      await budget.approve(cid, { request_key: key(), id: Number(b.id) }, checker)
    return budget.detail(cid, Number(b.id), '2026-10-31')
  })
  await stage('Payroll September dan batch 60 pegawai Oktober', async () => {
    const payroll = new PayrollService(),
      [policies] = await db.query<RowDataPacket[]>(
        'SELECT * FROM payroll_policies WHERE company_id=1 ORDER BY effective_from DESC LIMIT 1',
      )
    if (!policies[0])
      policies.push({
        health_employee_rate: 0.01,
        health_employer_rate: 0.04,
        health_wage_cap: 12000000,
        health_wage_floor: 0,
        jht_employee_rate: 0.02,
        jht_employer_rate: 0.037,
        jp_employee_rate: 0.01,
        jp_employer_rate: 0.02,
        jp_wage_cap: 10547400,
        jkk_employer_rate: 0.0024,
        jkm_employer_rate: 0.003,
      } as RowDataPacket)
    const policy = payrollPolicySchema.parse({
      ...policies[0],
      effective_from: '2026-01-01',
      salary_expense_account_id: accounts['6101'],
      employer_bpjs_expense_account_id: accounts['6110'],
      payroll_payable_account_id: accounts['2301'],
      bpjs_payable_account_id: accounts['2302'],
      pph21_payable_account_id: accounts['2303'],
      employee_loan_account_id: accounts['1131'],
      other_deduction_account_id: accounts['2304'],
      source_reference: 'Kebijakan contoh dummy untuk pengujian, bukan penetapan regulasi',
      notes: 'Data simulasi',
    })
    if (!policies[0]?.id) await payroll.savePolicy(cid, policy, actor)
    for (let n = 1; n <= 3; n++) {
      const number = `EMP-00${n}`,
        [existing] = await db.execute<RowDataPacket[]>(
          'SELECT id FROM payroll_employees WHERE company_id=1 AND employee_number=?',
          [number],
        )
      if (existing[0]) continue
      await payroll.saveEmployee(
        cid,
        null,
        payrollEmployeeSchema.parse({
          employee_number: number,
          name: `Pegawai Senior Dummy ${n}`,
          nik: `900000000000000${n}`,
          npwp: `900000000000000${n}`,
          email: `senior${n}@example.invalid`,
          department: 'Keuangan',
          hire_date: '2026-01-01',
          bank_name: 'BCA',
          bank_account_number: `990000000${n}`,
          bank_account_name: `Pegawai Senior Dummy ${n}`,
          bpjs_health_number: `990000000000${n}`,
          bpjs_employment_number: `880000000000${n}`,
          basic_salary: 6500000 + n * 1000000,
          fixed_allowance: 750000,
          is_active: true,
        }),
        actor,
      )
    }

    const [oldSep] = await db.query<RowDataPacket[]>(
      "SELECT id,status FROM payroll_runs WHERE company_id=1 AND period='2026-09'",
    )
    const sep =
      oldSep[0] ??
      (
        await payroll.createRun(
          cid,
          {
            period: '2026-09',
            pay_date: '2026-09-30',
            notes: 'Payroll contoh 3 pegawai; data fiktif',
          },
          actor,
        )
      ).run
    if (['draft', 'calculated'].includes(sep.status)) {
      const detail = await payroll.detail(cid, Number(sep.id))
      for (const [i, e] of detail.entries.entries())
        await payroll.updateEntry(cid, Number(sep.id), Number(e.id), {
          variable_allowance: 300000 + i * 100000,
          overtime: i === 2 ? 200000 : 0,
          bonus: i === 1 ? 500000 : 0,
          absence_deduction: i === 2 ? 50000 : 0,
        })
      await payroll.calculate(cid, Number(sep.id))
      await payroll.approve(cid, Number(sep.id), checker)
    }
    if ((await payroll.detail(cid, Number(sep.id))).run.status === 'approved')
      await payroll.post(cid, Number(sep.id), actor)
    if ((await payroll.detail(cid, Number(sep.id))).run.status === 'posted')
      await payroll.pay(cid, Number(sep.id), accounts['1102']!, '2026-09-30', actor)
    for (let n = 4; n <= 60; n++) {
      const number = `EMP-DEMO-${String(n).padStart(3, '0')}`,
        [old] = await db.execute<RowDataPacket[]>(
          'SELECT id FROM payroll_employees WHERE company_id=1 AND employee_number=?',
          [number],
        )
      if (old[0]) continue
      await payroll.saveEmployee(
        cid,
        null,
        payrollEmployeeSchema.parse({
          employee_number: number,
          name: `Pegawai Dummy ${String(n).padStart(3, '0')}`,
          nik: `900000000000${String(n).padStart(4, '0')}`,
          npwp: `900000000000${String(n).padStart(4, '0')}`,
          email: `pegawai${n}@example.invalid`,
          department: n % 2 ? 'Operasional' : 'Penjualan',
          position: 'Staff Demo',
          hire_date: '2026-10-01',
          bank_name: 'BCA',
          bank_account_number: `9900${String(n).padStart(6, '0')}`,
          bank_account_name: `Pegawai Dummy ${n}`,
          bpjs_health_number: `99000000${String(n).padStart(5, '0')}`,
          bpjs_employment_number: `88000000${String(n).padStart(5, '0')}`,
          basic_salary: 4500000 + n * 25000,
          fixed_allowance: 500000,
          is_active: true,
        }),
        actor,
      )
    }
    const [oldOct] = await db.query<RowDataPacket[]>(
      "SELECT id FROM payroll_runs WHERE company_id=1 AND period='2026-10'",
    )
    const oct =
      oldOct[0] ??
      (
        await payroll.createRun(
          cid,
          {
            period: '2026-10',
            pay_date: '2026-10-31',
            notes: 'Batch 60 pegawai; belum diposting agar dapat dikoreksi',
          },
          actor,
        )
      ).run
    await payroll.calculate(cid, Number(oct.id))
    const simulation = await payroll.simulatePolicy(cid, Number(oct.id), {
      ...policy,
      jht_employee_rate: 0.022,
    })
    await Bun.write('storage/demo-payroll-simulation.json', JSON.stringify(simulation, null, 2))
    return {
      september: Number(sep.id),
      october: Number(oct.id),
      employees: (await payroll.detail(cid, Number(oct.id))).entries.length,
    }
  })
  await stage('Aturan dan pemetaan impor bank tersimpan', async () => {
    const banking = new BankingService(),
      rules = await banking.matchingRules(cid),
      mappings = await banking.importMappings(cid)
    if (!rules.some((r) => r.name === 'Demo Referensi Pembayaran'))
      await banking.saveMatchingRule(
        cid,
        bankMatchingRuleSchema.parse({
          name: 'Demo Referensi Pembayaran',
          bank_account_id: bank.id,
          priority: 10,
          reference_pattern: 'DEMO-PAY',
          date_tolerance_days: 3,
        }),
        actor,
      )
    if (!mappings.some((m: any) => m.name === 'Demo CSV Rupiah'))
      await banking.saveImportMapping(
        cid,
        bankImportMappingSchema.parse({
          name: 'Demo CSV Rupiah',
          bank_account_id: bank.id,
          date_format: 'DD/MM/YYYY',
          column_mapping: {
            transaction_date: 'Tanggal',
            description: 'Keterangan',
            reference: 'Referensi',
            debit: 'Masuk',
            credit: 'Keluar',
            balance: 'Saldo',
          },
        }),
        actor,
      )
    return { rules: 1, mappings: 1 }
  })
  await stage('Mutasi bank dan rekonsiliasi jurnal', async () => {
    const banking = new BankingService()
    await db.execute(
      "DELETE FROM bank_statements WHERE company_id=1 AND statement_number='BST-DEMO-BCA-2026-08' AND NOT EXISTS(SELECT 1 FROM bank_reconciliations r WHERE r.bank_statement_id=bank_statements.id)",
    )
    for (const bank of banks) {
      const number = `DEMO-BANK-COMPLETE-${bank.code}`,
        [old] = await db.execute<RowDataPacket[]>(
          'SELECT id FROM bank_statements WHERE company_id=1 AND statement_number=?',
          [number],
        )
      if (old[0]) continue
      const [book] = await db.execute<RowDataPacket[]>(
        "SELECT l.id,l.debit,l.credit,j.journal_date,j.journal_number,j.description FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.company_id=1 AND l.account_id=? AND j.status IN('posted','reversed') AND j.journal_date<='2026-10-31' ORDER BY j.journal_date,j.id,l.id",
        [bank.gl_account_id],
      )
      if (!book.length) continue
      let balance = 0
      const lines = book.map((l) => {
        balance += Number(l.debit) - Number(l.credit)
        return {
          date:
            l.journal_date instanceof Date
              ? l.journal_date.toISOString().slice(0, 10)
              : String(l.journal_date).slice(0, 10),
          description: `[DUMMY] ${l.description}`,
          reference: l.journal_number,
          debit: String(l.debit),
          credit: String(l.credit),
          balance,
        }
      })
      const created = await banking.create(
        cid,
        statementSchema.parse({
          request_key: key(),
          bank_account_id: bank.id,
          number,
          date_from: '2026-01-01',
          date_to: '2026-10-31',
          opening_balance: 0,
          closing_balance: balance,
          balance_convention: 'debit_increases',
          lines,
        }),
        actor,
      )
      const [statement] = await db.execute<RowDataPacket[]>(
        'SELECT id FROM bank_statements WHERE company_id=1 AND statement_number=?',
        [number],
      )
      const [sl] = await db.execute<RowDataPacket[]>(
        'SELECT id FROM bank_statement_lines WHERE bank_statement_id=? ORDER BY line_number',
        [statement[0]!.id],
      )
      for (let i = 0; i < sl.length; i++)
        await banking.match(
          cid,
          {
            request_key: key(),
            statement_line_id: Number(sl[i]!.id),
            journal_line_id: Number(book[i]!.id),
          },
          actor,
        )
      await db.execute('UPDATE bank_accounts SET current_balance=? WHERE company_id=1 AND id=?', [
        balance,
        bank.id,
      ])
    }
    return {
      accounts: banks.length,
      note: 'Rekening koran sintetis untuk pengujian; bukan data bank asli',
    }
  })
  console.log(
    JSON.stringify(
      results.map((r) => ({
        feature: r.feature,
        status: r.status,
        detail: r.status === 'FAIL' ? r.detail : undefined,
      })),
      null,
      2,
    ),
  )
} finally {
  await db.end()
}
