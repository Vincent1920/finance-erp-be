import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { db, transaction } from '../config/database'
import { ConflictError, NotFoundError, ValidationError } from '../utils/AppError'
import { PostingService } from './PostingService'
import { AuditService } from './AuditService'

type Actor = { userId: number; requestId?: string | null; ip?: string | null }
type Row = RowDataPacket & Record<string, any>
const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const num = (n: unknown) => Number(n ?? 0)
const dateOnly = (v: any) =>
  typeof v === 'string' ? v.slice(0, 10) : new Date(v).toISOString().slice(0, 10)

export function calculateBpjs(salaryBase: number, policy: Record<string, unknown>) {
  const healthBase = Math.min(
    Math.max(salaryBase, num(policy.health_wage_floor)),
    num(policy.health_wage_cap),
  )
  const jpBase = Math.min(salaryBase, num(policy.jp_wage_cap))
  return {
    healthEmployee: round(healthBase * num(policy.health_employee_rate)),
    jhtEmployee: round(salaryBase * num(policy.jht_employee_rate)),
    jpEmployee: round(jpBase * num(policy.jp_employee_rate)),
    healthEmployer: round(healthBase * num(policy.health_employer_rate)),
    jhtEmployer: round(salaryBase * num(policy.jht_employer_rate)),
    jpEmployer: round(jpBase * num(policy.jp_employer_rate)),
    jkkEmployer: round(salaryBase * num(policy.jkk_employer_rate)),
    jkmEmployer: round(salaryBase * num(policy.jkm_employer_rate)),
  }
}

export class PayrollService {
  private posting = new PostingService()

  async overview(companyId: number, period: string) {
    const [[employees], [runs], [accounts], [policy]] = await Promise.all([
      db.query<Row[]>(
        `SELECT * FROM payroll_employees WHERE company_id=? ORDER BY is_active DESC,name`,
        [companyId],
      ),
      db.query<Row[]>(
        `SELECT r.*,u.name created_by_name,a.name approved_by_name FROM payroll_runs r JOIN users u ON u.id=r.created_by LEFT JOIN users a ON a.id=r.approved_by WHERE r.company_id=? ORDER BY period DESC,id DESC`,
        [companyId],
      ),
      db.query<Row[]>(
        `SELECT id,code,name,account_type FROM accounts WHERE company_id=? AND is_active=1 ORDER BY code`,
        [companyId],
      ),
      db.query<Row[]>(
        `SELECT * FROM payroll_policies WHERE company_id=? AND effective_from<=LAST_DAY(CONCAT(?,'-01')) AND (effective_to IS NULL OR effective_to>=CONCAT(?,'-01')) ORDER BY effective_from DESC LIMIT 1`,
        [companyId, period, period],
      ),
    ])
    const run = runs.find((r) => r.period === period) ?? null
    const detail = run ? await this.detail(companyId, Number(run.id)) : null
    return { period, employees, runs, accounts, policy: policy[0] ?? null, current_run: detail }
  }

  async saveEmployee(
    companyId: number,
    id: number | null,
    input: Record<string, any>,
    actor: Actor,
  ) {
    const fields = [
      'employee_number',
      'name',
      'nik',
      'npwp',
      'email',
      'department',
      'position',
      'employment_type',
      'ptkp_status',
      'ter_category',
      'hire_date',
      'termination_date',
      'bank_name',
      'bank_account_number',
      'bank_account_name',
      'bpjs_health_number',
      'bpjs_employment_number',
      'basic_salary',
      'fixed_allowance',
      'is_active',
    ]
    if (id) {
      const [result] = await db.query<any>(
        `UPDATE payroll_employees SET ${fields.map((f) => `${f}=?`).join(',')} WHERE id=? AND company_id=?`,
        [...fields.map((f) => input[f] ?? null), id, companyId],
      )
      if (!result.affectedRows) throw new NotFoundError('Pegawai tidak ditemukan')
      return { id }
    }
    const [result] = await db.query<any>(
      `INSERT INTO payroll_employees(company_id,${fields.join(',')},created_by) VALUES(?,${fields.map(() => '?').join(',')},?)`,
      [companyId, ...fields.map((f) => input[f] ?? null), actor.userId],
    )
    return { id: Number(result.insertId) }
  }

  async createRun(
    companyId: number,
    input: { period: string; pay_date: string; notes?: string | null },
    actor: Actor,
  ) {
    return transaction(async (cx) => {
      const [existing] = await cx.query<Row[]>(
        `SELECT id FROM payroll_runs WHERE company_id=? AND period=?`,
        [companyId, input.period],
      )
      if (existing.length) throw new ConflictError('Penggajian periode ini sudah dibuat')
      const [year, month] = input.period.split('-').map(Number)
      const from = `${input.period}-01`,
        to = new Date(Date.UTC(year!, month!, 0)).toISOString().slice(0, 10)
      const number = `PAY-${input.period.replace('-', '')}-001`
      const [result] = await cx.query<any>(
        `INSERT INTO payroll_runs(company_id,number,period,date_from,date_to,pay_date,notes,created_by) VALUES(?,?,?,?,?,?,?,?)`,
        [
          companyId,
          number,
          input.period,
          from,
          to,
          input.pay_date,
          input.notes ?? null,
          actor.userId,
        ],
      )
      const id = Number(result.insertId)
      await cx.query(
        `INSERT INTO payroll_entries(run_id,employee_id,basic_salary,fixed_allowance)
        SELECT ?,id,basic_salary,fixed_allowance FROM payroll_employees WHERE company_id=? AND is_active=1 AND hire_date<=? AND (termination_date IS NULL OR termination_date>=?)`,
        [id, companyId, to, from],
      )
      return this.detailWith(cx, companyId, id)
    })
  }

  async updateEntry(companyId: number, runId: number, entryId: number, input: Record<string, any>) {
    const allowed = Object.keys(input).filter((k) =>
      [
        'variable_allowance',
        'overtime',
        'bonus',
        'thr',
        'rapel',
        'reimbursement',
        'absence_deduction',
        'loan_deduction',
        'other_deduction',
        'pph21_override',
        'pph21_override_reason',
      ].includes(k),
    )
    if (!allowed.length) return { id: entryId }
    const [result] = await db.query<any>(
      `UPDATE payroll_entries e JOIN payroll_runs r ON r.id=e.run_id SET ${allowed.map((k) => `e.${k}=?`).join(',')} WHERE e.id=? AND e.run_id=? AND r.company_id=? AND r.status='draft'`,
      [...allowed.map((k) => input[k]), entryId, runId, companyId],
    )
    if (!result.affectedRows) throw new ConflictError('Baris hanya dapat diubah saat status Draft')
    return { id: entryId }
  }

  private expectedTerCategory(ptkp: string) {
    const normalized = String(ptkp ?? '')
      .toUpperCase()
      .replaceAll(' ', '')
    if (['TK/0', 'TK/1', 'K/0'].includes(normalized)) return 'A'
    if (['TK/2', 'TK/3', 'K/1', 'K/2'].includes(normalized)) return 'B'
    if (normalized === 'K/3') return 'C'
    return null
  }

  private ptkpAmount(ptkp: string) {
    const category = this.expectedTerCategory(ptkp)
    const amounts: Record<string, number> = {
      'TK/0': 54000000,
      'TK/1': 58500000,
      'K/0': 58500000,
      'TK/2': 63000000,
      'K/1': 63000000,
      'TK/3': 67500000,
      'K/2': 67500000,
      'K/3': 72000000,
    }
    return category
      ? (amounts[String(ptkp).toUpperCase().replaceAll(' ', '')] ?? 54000000)
      : 54000000
  }

  private validatePayroll(entries: Row[], policy: Row | null, runStatus = 'draft') {
    const issues: Array<{
      employee_id: number | null
      employee_number: string | null
      name: string
      severity: 'blocking' | 'warning'
      code: string
      message: string
    }> = []
    if (!policy)
      issues.push({
        employee_id: null,
        employee_number: null,
        name: 'Kebijakan payroll',
        severity: 'blocking',
        code: 'POLICY_MISSING',
        message: 'Kebijakan yang berlaku untuk periode ini belum tersedia.',
      })
    else {
      if (!policy.source_reference)
        issues.push({
          employee_id: null,
          employee_number: null,
          name: 'Kebijakan payroll',
          severity: 'warning',
          code: 'POLICY_SOURCE',
          message: 'Sumber peraturan atau dokumen kebijakan belum dicatat.',
        })
      if (num(policy.health_wage_floor) <= 0)
        issues.push({
          employee_id: null,
          employee_number: null,
          name: 'Kebijakan payroll',
          severity: 'warning',
          code: 'HEALTH_FLOOR',
          message: 'Batas minimum upah BPJS Kesehatan belum diisi.',
        })
    }
    for (const entry of entries) {
      const identity = {
        employee_id: Number(entry.employee_id),
        employee_number: String(entry.employee_number),
        name: String(entry.name),
      }
      const expected = this.expectedTerCategory(entry.ptkp_status)
      if (!expected)
        issues.push({
          ...identity,
          severity: 'blocking',
          code: 'PTKP_INVALID',
          message: `Status PTKP ${entry.ptkp_status || 'kosong'} tidak dikenali.`,
        })
      else if (expected !== entry.ter_category)
        issues.push({
          ...identity,
          severity: 'warning',
          code: 'TER_MISMATCH',
          message: `Kategori TER akan dihitung sebagai ${expected} berdasarkan PTKP ${entry.ptkp_status}.`,
        })
      if (!entry.bank_account_number)
        issues.push({
          ...identity,
          severity: 'blocking',
          code: 'BANK_MISSING',
          message: 'Nomor rekening pembayaran belum diisi.',
        })
      if (entry.employment_type === 'non_employee')
        issues.push({
          ...identity,
          severity: 'blocking',
          code: 'NON_EMPLOYEE_RULE',
          message:
            'Bukan pegawai harus diproses dengan skema PPh 21 khusus dan tidak boleh memakai perhitungan payroll pegawai.',
        })
      if (entry.employment_type !== 'non_employee' && !entry.bpjs_health_number)
        issues.push({
          ...identity,
          severity: 'warning',
          code: 'BPJS_HEALTH_MISSING',
          message: 'Nomor BPJS Kesehatan belum diisi.',
        })
      if (entry.employment_type !== 'non_employee' && !entry.bpjs_employment_number)
        issues.push({
          ...identity,
          severity: 'warning',
          code: 'BPJS_EMPLOYMENT_MISSING',
          message: 'Nomor BPJS Ketenagakerjaan belum diisi.',
        })
      if (entry.pph21_override !== null && !entry.pph21_override_reason)
        issues.push({
          ...identity,
          severity: 'blocking',
          code: 'TAX_OVERRIDE_REASON',
          message: 'Koreksi manual PPh 21 belum mempunyai alasan.',
        })
      if (num(entry.take_home_pay) === 0 && num(entry.gross_earnings) > 0)
        issues.push({
          ...identity,
          severity: 'warning',
          code: 'ZERO_THP',
          message: 'Take Home Pay bernilai nol.',
        })
      if (policy && runStatus !== 'draft') {
        const expectedBpjs = calculateBpjs(
          num(entry.basic_salary) + num(entry.fixed_allowance),
          policy,
        )
        const comparisons: Array<[string, number, unknown]> = [
          ['Kesehatan pegawai', expectedBpjs.healthEmployee, entry.bpjs_health_employee],
          ['JHT pegawai', expectedBpjs.jhtEmployee, entry.bpjs_jht_employee],
          ['JP pegawai', expectedBpjs.jpEmployee, entry.bpjs_jp_employee],
          ['Kesehatan perusahaan', expectedBpjs.healthEmployer, entry.bpjs_health_employer],
          ['JHT perusahaan', expectedBpjs.jhtEmployer, entry.bpjs_jht_employer],
          ['JP perusahaan', expectedBpjs.jpEmployer, entry.bpjs_jp_employer],
          ['JKK perusahaan', expectedBpjs.jkkEmployer, entry.bpjs_jkk_employer],
          ['JKM perusahaan', expectedBpjs.jkmEmployer, entry.bpjs_jkm_employer],
        ]
        for (const [label, expectedValue, actualValue] of comparisons)
          if (Math.abs(expectedValue - num(actualValue)) >= 0.01)
            issues.push({
              ...identity,
              severity: 'blocking',
              code: 'BPJS_CALCULATION_MISMATCH',
              message: `${label} tidak sesuai kebijakan: seharusnya ${expectedValue.toFixed(2)}, tercatat ${num(actualValue).toFixed(2)}. Hitung ulang payroll.`,
            })
      }
    }
    return {
      issues,
      blocking: issues.filter((issue) => issue.severity === 'blocking').length,
      warnings: issues.filter((issue) => issue.severity === 'warning').length,
    }
  }

  private terFallback(category: string, gross: number) {
    const thresholds: Record<string, Array<[number, number]>> = {
      A: [
        [5400000, 0],
        [5650000, 0.0025],
        [5950000, 0.005],
        [6300000, 0.0075],
        [6750000, 0.01],
        [7500000, 0.0125],
        [8550000, 0.015],
        [9650000, 0.0175],
        [10050000, 0.02],
        [10350000, 0.0225],
        [10700000, 0.025],
        [11050000, 0.03],
        [11600000, 0.035],
        [12500000, 0.04],
        [13750000, 0.05],
        [15100000, 0.06],
        [16950000, 0.07],
        [19750000, 0.08],
        [24150000, 0.09],
        [26450000, 0.1],
        [28000000, 0.11],
        [30050000, 0.12],
        [32400000, 0.13],
        [35400000, 0.14],
        [39100000, 0.15],
        [43850000, 0.16],
        [47800000, 0.17],
        [51400000, 0.18],
        [56300000, 0.19],
        [62200000, 0.2],
        [68600000, 0.21],
        [77500000, 0.22],
        [89000000, 0.23],
        [103000000, 0.24],
        [125000000, 0.25],
        [157000000, 0.26],
        [206000000, 0.27],
        [337000000, 0.28],
        [454000000, 0.29],
        [550000000, 0.3],
        [695000000, 0.31],
        [910000000, 0.32],
        [1400000000, 0.33],
        [Infinity, 0.34],
      ],
      B: [
        [6200000, 0],
        [6500000, 0.0025],
        [6850000, 0.005],
        [7300000, 0.0075],
        [9200000, 0.01],
        [10750000, 0.015],
        [11250000, 0.02],
        [11600000, 0.025],
        [12600000, 0.03],
        [13600000, 0.04],
        [14950000, 0.05],
        [16400000, 0.06],
        [18450000, 0.07],
        [21850000, 0.08],
        [26000000, 0.09],
        [27700000, 0.1],
        [29350000, 0.11],
        [31450000, 0.12],
        [33950000, 0.13],
        [37100000, 0.14],
        [41100000, 0.15],
        [45800000, 0.16],
        [49500000, 0.17],
        [53800000, 0.18],
        [58500000, 0.19],
        [64000000, 0.2],
        [71000000, 0.21],
        [80000000, 0.22],
        [93000000, 0.23],
        [109000000, 0.24],
        [129000000, 0.25],
        [163000000, 0.26],
        [211000000, 0.27],
        [374000000, 0.28],
        [459000000, 0.29],
        [555000000, 0.3],
        [704000000, 0.31],
        [957000000, 0.32],
        [1405000000, 0.33],
        [Infinity, 0.34],
      ],
      C: [
        [6600000, 0],
        [6950000, 0.0025],
        [7350000, 0.005],
        [7800000, 0.0075],
        [8850000, 0.01],
        [9800000, 0.0125],
        [10950000, 0.015],
        [11200000, 0.0175],
        [12050000, 0.02],
        [12950000, 0.03],
        [14150000, 0.04],
        [15550000, 0.05],
        [17050000, 0.06],
        [19500000, 0.07],
        [22700000, 0.08],
        [26600000, 0.09],
        [28100000, 0.1],
        [30100000, 0.11],
        [32600000, 0.12],
        [35400000, 0.13],
        [38900000, 0.14],
        [43000000, 0.15],
        [47400000, 0.16],
        [51200000, 0.17],
        [55800000, 0.18],
        [60400000, 0.19],
        [66700000, 0.2],
        [74500000, 0.21],
        [83200000, 0.22],
        [95600000, 0.23],
        [110000000, 0.24],
        [134000000, 0.25],
        [169000000, 0.26],
        [221000000, 0.27],
        [390000000, 0.28],
        [463000000, 0.29],
        [561000000, 0.3],
        [709000000, 0.31],
        [965000000, 0.32],
        [1419000000, 0.33],
        [Infinity, 0.34],
      ],
    }
    return (thresholds[category] ?? thresholds.A!).find(([limit]) => gross <= limit)?.[1] ?? 0.34
  }

  private annualTax(pk: number) {
    let rest = Math.max(0, Math.floor(pk / 1000) * 1000),
      tax = 0
    for (const [band, rate] of [
      [60000000, 0.05],
      [190000000, 0.15],
      [250000000, 0.25],
      [4500000000, 0.3],
      [Infinity, 0.35],
    ] as Array<[number, number]>) {
      const part = Math.min(rest, band)
      tax += part * rate
      rest -= part
      if (rest <= 0) break
    }
    return round(tax)
  }

  async calculate(companyId: number, id: number) {
    return transaction(async (cx) => {
      const run = await this.runForUpdate(cx, companyId, id)
      if (!['draft', 'calculated'].includes(run.status))
        throw new ConflictError('Penggajian yang sudah disetujui tidak dapat dihitung ulang')
      const [policies] = await cx.query<Row[]>(
        `SELECT * FROM payroll_policies WHERE company_id=? AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY effective_from DESC LIMIT 1`,
        [companyId, dateOnly(run.date_to), dateOnly(run.date_from)],
      )
      const p = policies[0]
      if (!p) throw new ValidationError('Pengaturan payroll untuk periode ini belum tersedia')
      const [entries] = await cx.query<Row[]>(
        `SELECT e.*,m.employee_number,m.name,m.ter_category,m.ptkp_status,m.termination_date,m.hire_date,m.prior_year_income,m.prior_year_tax FROM payroll_entries e JOIN payroll_employees m ON m.id=e.employee_id WHERE e.run_id=?`,
        [id],
      )
      const [ytdRows] = await cx.query<Row[]>(
        `SELECT pe.employee_id,COALESCE(SUM(pe.taxable_gross),0) gross,COALESCE(SUM(pe.pph21),0) tax,COALESCE(SUM(pe.bpjs_jht_employee+pe.bpjs_jp_employee),0) pension FROM payroll_entries pe JOIN payroll_runs pr ON pr.id=pe.run_id WHERE pr.company_id=? AND pr.period>=CONCAT(LEFT(? ,4),'-01') AND pr.period<? AND pr.status IN ('calculated','approved','posted','paid','locked') GROUP BY pe.employee_id`,
        [companyId, run.period, run.period],
      )
      const ytd = new Map(ytdRows.map((row) => [Number(row.employee_id), row]))
      for (const e of entries) {
        const gross = round(
          num(e.basic_salary) +
            num(e.fixed_allowance) +
            num(e.variable_allowance) +
            num(e.overtime) +
            num(e.bonus) +
            num(e.thr) +
            num(e.rapel) +
            num(e.reimbursement),
        )
        const bpjsBase = num(e.basic_salary) + num(e.fixed_allowance),
          bpjs = calculateBpjs(bpjsBase, p)
        const he = bpjs.healthEmployee,
          je = bpjs.jhtEmployee,
          pe = bpjs.jpEmployee
        const hc = bpjs.healthEmployer,
          jc = bpjs.jhtEmployer,
          pc = bpjs.jpEmployer,
          jkk = bpjs.jkkEmployer,
          jkm = bpjs.jkmEmployer
        const employeeBpjs = he + je + pe,
          employerBpjs = hc + jc + pc + jkk + jkm,
          taxable = round(gross + hc + jkk + jkm)
        const terCategory = this.expectedTerCategory(e.ptkp_status) ?? e.ter_category
        let rate = this.terFallback(terCategory, taxable),
          pph = round(taxable * rate),
          note = `PPh 21 dihitung dengan TER ${terCategory} berdasarkan PTKP ${e.ptkp_status}`
        const terminationInPeriod =
          e.termination_date &&
          dateOnly(e.termination_date) >= dateOnly(run.date_from) &&
          dateOnly(e.termination_date) <= dateOnly(run.date_to)
        if (run.period.endsWith('-12') || terminationInPeriod) {
          const previous = ytd.get(Number(e.employee_id)),
            annualGross = num(e.prior_year_income) + num(previous?.gross) + taxable
          const startMonth = Math.max(1, Number(String(e.hire_date).slice(5, 7)) || 1),
            endMonth = Number(run.period.slice(5, 7)),
            months = Math.max(1, endMonth - startMonth + 1)
          const positionCost = Math.min(500000 * months, annualGross * 0.05),
            pension = num(previous?.pension) + je + pe
          const taxableAnnual =
            annualGross - positionCost - pension - this.ptkpAmount(e.ptkp_status)
          const annual = this.annualTax(taxableAnnual),
            previousTax = num(e.prior_year_tax) + num(previous?.tax)
          pph = Math.max(0, round(annual - previousTax))
          rate = taxable ? pph / taxable : 0
          note =
            'PPh 21 masa terakhir: tarif progresif tahunan setelah biaya jabatan, iuran JHT/JP, dan PTKP'
        }
        if (e.pph21_override !== null) {
          pph = num(e.pph21_override)
          note = 'PPh 21 memakai koreksi manual yang dicatat pengguna'
        }
        const operational = round(
            num(e.absence_deduction) + num(e.loan_deduction) + num(e.other_deduction),
          ),
          thp = round(gross - operational - employeeBpjs - pph),
          cost = round(gross - num(e.absence_deduction) + employerBpjs)
        if (thp < 0) throw new ValidationError('Take home pay tidak boleh negatif')
        await cx.query(
          `UPDATE payroll_entries SET bpjs_health_employee=?,bpjs_jht_employee=?,bpjs_jp_employee=?,bpjs_health_employer=?,bpjs_jht_employer=?,bpjs_jp_employer=?,bpjs_jkk_employer=?,bpjs_jkm_employer=?,taxable_gross=?,ter_rate=?,pph21=?,gross_earnings=?,operational_deductions=?,employee_bpjs=?,employer_bpjs=?,take_home_pay=?,company_cost=?,calculation_note=? WHERE id=?`,
          [
            he,
            je,
            pe,
            hc,
            jc,
            pc,
            jkk,
            jkm,
            taxable,
            rate,
            pph,
            gross,
            operational,
            employeeBpjs,
            employerBpjs,
            thp,
            cost,
            note,
            e.id,
          ],
        )
      }
      await cx.query(
        `UPDATE payroll_runs r JOIN (SELECT run_id,SUM(gross_earnings) gross,SUM(operational_deductions) deductions,SUM(employee_bpjs) employee_bpjs,SUM(employer_bpjs) employer_bpjs,SUM(pph21) pph,SUM(take_home_pay) thp,SUM(company_cost) cost FROM payroll_entries WHERE run_id=? GROUP BY run_id) x ON x.run_id=r.id SET r.status='calculated',r.policy_id=?,r.calculation_version='2026.1',r.calculated_at=NOW(),r.total_gross=x.gross,r.total_operational_deductions=x.deductions,r.total_employee_bpjs=x.employee_bpjs,r.total_employer_bpjs=x.employer_bpjs,r.total_pph21=x.pph,r.total_take_home_pay=x.thp,r.total_company_cost=x.cost WHERE r.id=?`,
        [id, p.id, id],
      )
      return this.detailWith(cx, companyId, id)
    })
  }

  async approve(companyId: number, id: number, actor: Actor) {
    return transaction(async (cx) => {
      const r = await this.runForUpdate(cx, companyId, id)
      if (r.status !== 'calculated') throw new ConflictError('Hitung payroll sebelum persetujuan')
      const detail = await this.detailWith(cx, companyId, id)
      if (detail.validation.blocking)
        throw new ConflictError(
          `${detail.validation.blocking} masalah wajib diselesaikan sebelum payroll disetujui`,
        )
      if (Number(r.created_by) === actor.userId) {
        const [settings] = await cx.query<Row[]>(
          `SELECT setting_value FROM settings WHERE company_id=? AND setting_key='accounting.allow_self_approval' LIMIT 1`,
          [companyId],
        )
        const value = settings[0]?.setting_value
        const allowed =
          value === true ||
          value === 1 ||
          value === '1' ||
          value === 'true' ||
          value === 'yes' ||
          value === 'enabled'
        if (!allowed)
          throw new ConflictError(
            'Pembuat payroll tidak dapat menyetujui payroll yang sama. Minta pengguna lain menyetujui atau aktifkan izin persetujuan sendiri di Pengaturan.',
          )
      }
      await cx.query(
        `UPDATE payroll_runs SET status='approved',approved_by=?,approved_at=NOW() WHERE id=?`,
        [actor.userId, id],
      )
      return this.detailWith(cx, companyId, id)
    })
  }

  async reopen(companyId: number, id: number, reason: string, actor: Actor) {
    return transaction(async (cx) => {
      const r = await this.runForUpdate(cx, companyId, id)
      if (!['calculated', 'approved'].includes(r.status))
        throw new ConflictError(
          'Hanya payroll yang sudah dihitung atau disetujui dan belum diposting yang dapat dikembalikan ke Draft',
        )
      await cx.query(
        `UPDATE payroll_runs SET status='draft',approved_by=NULL,approved_at=NULL WHERE id=?`,
        [id],
      )
      await new AuditService().log(cx, {
        companyId,
        userId: actor.userId,
        module: 'payroll',
        action: 'reopen',
        recordType: 'payroll_run',
        recordId: id,
        oldValue: { status: r.status },
        newValue: { status: 'draft', reason },
        requestId: actor.requestId,
        ip: actor.ip,
      })
      return this.detailWith(cx, companyId, id)
    })
  }

  async post(companyId: number, id: number, actor: Actor) {
    return transaction(async (cx) => {
      const r = await this.runForUpdate(cx, companyId, id)
      if (r.status !== 'approved')
        throw new ConflictError('Hanya payroll disetujui yang dapat diposting')
      const p = await this.policy(cx, companyId, dateOnly(r.date_to))
      const [e] = await cx.query<Row[]>(
        `SELECT SUM(gross_earnings-absence_deduction) salary,SUM(employer_bpjs) employer,SUM(employee_bpjs+employer_bpjs) bpjs,SUM(pph21) pph,SUM(loan_deduction) loan,SUM(other_deduction) other,SUM(take_home_pay) thp FROM payroll_entries WHERE run_id=?`,
        [id],
      )
      const x = e[0]!
      const lines = [
        this.line(p.salary_expense_account_id, num(x.salary), 0, 'Beban gaji'),
        this.line(p.employer_bpjs_expense_account_id, num(x.employer), 0, 'BPJS perusahaan'),
        this.line(p.bpjs_payable_account_id, 0, num(x.bpjs), 'Utang BPJS'),
        this.line(p.pph21_payable_account_id, 0, num(x.pph), 'Utang PPh 21'),
        this.line(p.employee_loan_account_id, 0, num(x.loan), 'Potongan pinjaman pegawai'),
        this.line(p.other_deduction_account_id, 0, num(x.other), 'Potongan lainnya'),
        this.line(p.payroll_payable_account_id, 0, num(x.thp), 'Utang gaji'),
      ].filter((l) => l.debit > 0 || l.credit > 0)
      const journalId = await this.posting.createPostedJournal(cx, {
        companyId,
        sourceType: 'payroll',
        sourceId: id,
        date: dateOnly(r.date_to),
        reference: r.number,
        description: `Payroll ${r.period}`,
        lines,
        context: actor,
      })
      await cx.query(
        `UPDATE payroll_runs SET status='posted',journal_id=?,posted_by=?,posted_at=NOW() WHERE id=?`,
        [journalId, actor.userId, id],
      )
      await this.syncTax(cx, companyId, r, actor.userId)
      return this.detailWith(cx, companyId, id)
    })
  }

  async pay(
    companyId: number,
    id: number,
    paymentAccountId: number,
    paymentDate: string,
    actor: Actor,
  ) {
    return transaction(async (cx) => {
      const r = await this.runForUpdate(cx, companyId, id)
      if (r.status !== 'posted') throw new ConflictError('Payroll harus diposting sebelum dibayar')
      if (paymentDate < dateOnly(r.date_to))
        throw new ValidationError('Tanggal pembayaran tidak boleh sebelum akhir periode payroll')
      const [accounts] = await cx.query<Row[]>(
        `SELECT id FROM accounts WHERE id=? AND company_id=? AND account_type='asset' AND is_posting=TRUE AND is_active=TRUE AND deleted_at IS NULL`,
        [paymentAccountId, companyId],
      )
      if (!accounts[0])
        throw new ValidationError(
          'Akun pembayaran harus akun aset aktif yang dapat menerima posting',
        )
      const p = await this.policy(cx, companyId, dateOnly(r.date_to))
      const journalId = await this.posting.createPostedJournal(cx, {
        companyId,
        sourceType: 'payroll_payment',
        sourceId: id,
        date: paymentDate,
        reference: r.number,
        description: `Pembayaran ${r.number}`,
        lines: [
          this.line(
            p.payroll_payable_account_id,
            num(r.total_take_home_pay),
            0,
            'Pelunasan utang gaji',
          ),
          this.line(paymentAccountId, 0, num(r.total_take_home_pay), 'Transfer gaji'),
        ],
        context: actor,
      })
      await cx.query(
        `UPDATE payroll_runs SET status='paid',payment_journal_id=?,payment_account_id=?,paid_by=?,paid_at=NOW() WHERE id=?`,
        [journalId, paymentAccountId, actor.userId, id],
      )
      return this.detailWith(cx, companyId, id)
    })
  }
  async lock(companyId: number, id: number, actor: Actor) {
    return transaction(async (cx) => {
      const r = await this.runForUpdate(cx, companyId, id)
      if (r.status !== 'paid') throw new ConflictError('Payroll dapat dikunci setelah dibayar')
      await cx.query(
        `UPDATE payroll_runs SET status='locked',locked_by=?,locked_at=NOW() WHERE id=?`,
        [actor.userId, id],
      )
      await new AuditService().log(cx, {
        companyId,
        userId: actor.userId,
        module: 'payroll',
        action: 'lock',
        recordType: 'payroll_run',
        recordId: id,
        oldValue: { status: r.status },
        newValue: { status: 'locked' },
        requestId: actor.requestId,
        ip: actor.ip,
      })
      return this.detailWith(cx, companyId, id)
    })
  }
  async savePolicy(companyId: number, input: Record<string, any>, actor: Actor) {
    return transaction(async (cx) => {
      const accountRules: Array<[string, 'asset' | 'liability' | 'expense', string]> = [
        ['salary_expense_account_id', 'expense', 'Beban gaji'],
        ['employer_bpjs_expense_account_id', 'expense', 'Beban BPJS perusahaan'],
        ['payroll_payable_account_id', 'liability', 'Utang gaji'],
        ['bpjs_payable_account_id', 'liability', 'Utang BPJS'],
        ['pph21_payable_account_id', 'liability', 'Utang PPh 21'],
        ['employee_loan_account_id', 'asset', 'Piutang pegawai'],
        ['other_deduction_account_id', 'liability', 'Utang potongan lain'],
      ]
      const accountIds = accountRules.map(([field]) => Number(input[field]))
      const [accounts] = await cx.query<Row[]>(
        `SELECT id,account_type FROM accounts
         WHERE company_id=? AND id IN (${accountIds.map(() => '?').join(',')})
           AND is_active=TRUE AND is_posting=TRUE AND deleted_at IS NULL`,
        [companyId, ...accountIds],
      )
      const types = new Map(accounts.map((account) => [Number(account.id), account.account_type]))
      for (const [field, expectedType, label] of accountRules) {
        if (types.get(Number(input[field])) !== expectedType)
          throw new ValidationError(
            `${label} harus memakai akun ${expectedType} aktif yang dapat menerima posting`,
          )
      }
      const [existing] = await cx.query<Row[]>(
        `SELECT p.id,EXISTS(SELECT 1 FROM payroll_runs r WHERE r.policy_id=p.id AND r.status IN('calculated','approved','posted','paid','locked')) used FROM payroll_policies p WHERE p.company_id=? AND p.effective_from=? FOR UPDATE`,
        [companyId, input.effective_from],
      )
      if (existing[0]?.used)
        throw new ConflictError(
          'Kebijakan ini sudah dipakai payroll. Buat kebijakan baru dengan tanggal efektif baru agar riwayat perhitungan tetap dapat diaudit.',
        )
      const f = Object.keys(input)
      await cx.query(
        `INSERT INTO payroll_policies(company_id,${f.join(',')},created_by) VALUES(?,${f.map(() => '?').join(',')},?) ON DUPLICATE KEY UPDATE ${f
          .filter((x) => x !== 'effective_from')
          .map((x) => `${x}=VALUES(${x})`)
          .join(',')}`,
        [companyId, ...f.map((k) => input[k]), actor.userId],
      )
      await new AuditService().log(cx, {
        companyId,
        userId: actor.userId,
        module: 'payroll',
        action: 'save_policy',
        recordType: 'payroll_policy',
        recordId: Number(existing[0]?.id ?? 0) || null,
        newValue: { effectiveFrom: input.effective_from, sourceReference: input.source_reference },
        requestId: actor.requestId,
        ip: actor.ip,
      })
      return { saved: true }
    })
  }
  async detail(companyId: number, id: number) {
    return this.detailWith(db, companyId, id)
  }
  private async detailWith(cx: any, companyId: number, id: number) {
    const [runs] = await cx.query(
      `SELECT r.*,u.name created_by_name,a.name approved_by_name FROM payroll_runs r JOIN users u ON u.id=r.created_by LEFT JOIN users a ON a.id=r.approved_by WHERE r.id=? AND r.company_id=?`,
      [id, companyId],
    )
    if (!runs[0]) throw new NotFoundError('Payroll tidak ditemukan')
    const [entries] = await cx.query(
      `SELECT e.*,m.employee_number,m.name,m.nik,m.npwp,m.department,m.position,m.employment_type,m.bank_name,m.bank_account_number,m.bank_account_name,m.ptkp_status,m.ter_category,m.bpjs_health_number,m.bpjs_employment_number FROM payroll_entries e JOIN payroll_employees m ON m.id=e.employee_id WHERE e.run_id=? ORDER BY m.name`,
      [id],
    )
    const r = runs[0]
    r.date_from = dateOnly(r.date_from)
    r.date_to = dateOnly(r.date_to)
    r.pay_date = dateOnly(r.pay_date)
    const [policies] = await cx.query(
      `SELECT * FROM payroll_policies WHERE id=COALESCE(?,id) AND company_id=? AND effective_from<=? ORDER BY effective_from DESC LIMIT 1`,
      [r.policy_id, companyId, r.date_to],
    )
    const validation = this.validatePayroll(entries as Row[], policies[0] ?? null, r.status)
    return {
      run: r,
      entries,
      validation,
      reconciliation: {
        ledger: { amount: num(r.total_company_cost), matched: !!r.journal_id },
        bank: { amount: num(r.total_take_home_pay), matched: !!r.payment_journal_id },
        bpjs: {
          amount: num(r.total_employee_bpjs) + num(r.total_employer_bpjs),
          matched: !!r.journal_id,
        },
        pph21: { amount: num(r.total_pph21), matched: !!r.journal_id },
      },
    }
  }
  private async runForUpdate(cx: PoolConnection, companyId: number, id: number) {
    const [r] = await cx.query<Row[]>(
      `SELECT * FROM payroll_runs WHERE id=? AND company_id=? FOR UPDATE`,
      [id, companyId],
    )
    if (!r[0]) throw new NotFoundError('Payroll tidak ditemukan')
    return r[0]
  }
  private async policy(cx: any, companyId: number, date: string) {
    const [r] = await cx.query(
      `SELECT * FROM payroll_policies WHERE company_id=? AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY effective_from DESC LIMIT 1`,
      [companyId, date, date],
    )
    if (!r[0]) throw new ValidationError('Pengaturan payroll belum tersedia')
    for (const k of [
      'salary_expense_account_id',
      'employer_bpjs_expense_account_id',
      'payroll_payable_account_id',
      'bpjs_payable_account_id',
      'pph21_payable_account_id',
      'employee_loan_account_id',
      'other_deduction_account_id',
    ])
      if (!r[0][k]) throw new ValidationError('Pemetaan akun payroll belum lengkap')
    return r[0]
  }
  private line(accountId: any, debit: number, credit: number, description: string) {
    return { accountId: Number(accountId), debit, credit, description }
  }
  private async syncTax(cx: PoolConnection, companyId: number, run: Row, userId: number) {
    let [p] = await cx.query<Row[]>(
      `SELECT id FROM tax_reconciliation_periods WHERE company_id=? AND tax_period=?`,
      [companyId, run.period],
    )
    let pid = p[0]?.id
    if (!pid) {
      const [x] = await cx.query<any>(
        `INSERT INTO tax_reconciliation_periods(company_id,tax_period) VALUES(?,?)`,
        [companyId, run.period],
      )
      pid = x.insertId
    }
    await cx.query(
      `DELETE FROM tax_internal_rows WHERE company_id=? AND period_id=? AND description LIKE 'Payroll:%'`,
      [companyId, pid],
    )
    await cx.query(
      `INSERT INTO tax_internal_rows(company_id,period_id,tax_type,document_number,document_date,counterparty_tax_number,counterparty_name,tax_code,dpp,tax_amount,description,created_by) SELECT ?,?,'pph21_employee',CONCAT('PAYROLL-',r.period,'-',m.employee_number),r.date_to,m.npwp,m.name,'PPh21',e.taxable_gross,e.pph21,CONCAT('Payroll:',r.number),? FROM payroll_entries e JOIN payroll_runs r ON r.id=e.run_id JOIN payroll_employees m ON m.id=e.employee_id WHERE e.run_id=?`,
      [companyId, pid, userId, run.id],
    )
  }
}
