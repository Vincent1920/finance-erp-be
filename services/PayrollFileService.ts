import ExcelJS from 'exceljs'
import { parse } from 'csv-parse/sync'
import { stringify } from 'csv-stringify/sync'
import type { RowDataPacket } from 'mysql2/promise'

import { db, transaction } from '../config/database'
import { ConflictError, NotFoundError, ValidationError } from '../utils/AppError'
import { AuditService } from './AuditService'

type Row = RowDataPacket & Record<string, any>
type Actor = { userId: number; requestId?: string | null; ip?: string | null }

const componentColumns = [
  'variable_allowance',
  'overtime',
  'bonus',
  'thr',
  'rapel',
  'reimbursement',
  'absence_deduction',
  'loan_deduction',
  'other_deduction',
] as const

const aliases: Record<string, string> = {
  nomor_pegawai: 'employee_number',
  nip: 'employee_number',
  employee_number: 'employee_number',
  tunjangan_variabel: 'variable_allowance',
  variable_allowance: 'variable_allowance',
  lembur: 'overtime',
  overtime: 'overtime',
  bonus: 'bonus',
  thr: 'thr',
  rapel: 'rapel',
  reimbursement: 'reimbursement',
  penggantian_biaya: 'reimbursement',
  potongan_absensi: 'absence_deduction',
  absence_deduction: 'absence_deduction',
  potongan_pinjaman: 'loan_deduction',
  loan_deduction: 'loan_deduction',
  potongan_lain: 'other_deduction',
  other_deduction: 'other_deduction',
}

const normalizeHeader = (value: unknown) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')

const parseLocalizedNumber = (value: unknown) => {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  let text = String(value).trim().replace(/rp/gi, '').replace(/\s/g, '')
  if (!text) return null
  if (text.includes(',') && text.includes('.')) text = text.replace(/\./g, '').replace(',', '.')
  else if (text.includes(',')) text = text.replace(',', '.')
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(text)) text = text.replace(/\./g, '')
  return Number(text)
}
const spreadsheetSafe = (records: Record<string, unknown>[]) =>
  records.map((record) =>
    Object.fromEntries(
      Object.entries(record).map(([key, value]) => [
        key,
        typeof value === 'string' && /^[=+\-@]/.test(value) ? `'${value}` : value,
      ]),
    ),
  )

export class PayrollFileService {
  private audit = new AuditService()

  async preview(companyId: number, runId: number, file: File) {
    const run = await this.getDraftRun(companyId, runId)
    const sourceRows = await this.readFile(file)
    const [employees] = await db.query<Row[]>(
      `SELECT e.id,e.employee_number,e.name
         FROM payroll_entries pe
         JOIN payroll_employees e ON e.id=pe.employee_id
        WHERE pe.run_id=? ORDER BY e.employee_number`,
      [runId],
    )
    const result = this.validateRows(sourceRows, employees)
    return {
      run: { id: run.id, number: run.number, period: run.period },
      filename: file.name,
      ...result,
    }
  }

  async apply(companyId: number, runId: number, file: File, actor: Actor) {
    const preview = await this.preview(companyId, runId, file)
    if (preview.invalid_rows)
      throw new ValidationError(
        `Impor belum dapat diterapkan. Perbaiki ${preview.invalid_rows} baris yang bermasalah.`,
      )
    return transaction(async (cx) => {
      const [runs] = await cx.query<Row[]>(
        `SELECT id,number,status FROM payroll_runs WHERE id=? AND company_id=? FOR UPDATE`,
        [runId, companyId],
      )
      if (!runs[0]) throw new NotFoundError('Payroll tidak ditemukan')
      if (runs[0].status !== 'draft')
        throw new ConflictError('Komponen hanya dapat diimpor ketika payroll berstatus Draft')

      for (const row of preview.rows) {
        const values = row.values as Record<string, number>
        const fields = Object.keys(values).filter((key) =>
          componentColumns.includes(key as (typeof componentColumns)[number]),
        )
        if (!fields.length) continue
        await cx.query(
          `UPDATE payroll_entries pe
             JOIN payroll_employees e ON e.id=pe.employee_id
              SET ${fields.map((field) => `pe.${field}=?`).join(',')}
            WHERE pe.run_id=? AND e.company_id=? AND e.employee_number=?`,
          [...fields.map((field) => values[field]), runId, companyId, row.employee_number],
        )
      }
      await this.audit.log(cx, {
        companyId,
        userId: actor.userId,
        module: 'payroll',
        action: 'import_components',
        recordType: 'payroll_run',
        recordId: runId,
        recordNumber: String(runs[0].number),
        newValue: {
          filename: file.name,
          importedRows: preview.valid_rows,
          components: preview.components,
        },
        requestId: actor.requestId,
        ip: actor.ip,
      })
      return { imported_rows: preview.valid_rows, filename: file.name }
    })
  }

  async export(companyId: number, runId: number, kind: string) {
    const [runs] = await db.query<Row[]>(
      `SELECT id,number,period,status FROM payroll_runs WHERE id=? AND company_id=?`,
      [runId, companyId],
    )
    const run = runs[0]
    if (!run) throw new NotFoundError('Payroll tidak ditemukan')
    const [rows] = await db.query<Row[]>(
      `SELECT pe.*,e.employee_number,e.name,e.nik,e.npwp,e.ptkp_status,e.ter_category,
              e.bank_name,e.bank_account_number,e.bank_account_name,
              e.bpjs_health_number,e.bpjs_employment_number
         FROM payroll_entries pe
         JOIN payroll_employees e ON e.id=pe.employee_id
        WHERE pe.run_id=? ORDER BY e.employee_number`,
      [runId],
    )
    if (!rows.length) throw new ValidationError('Payroll belum memiliki pegawai')

    let records: Record<string, unknown>[]
    let suffix: string
    if (kind === 'bank') {
      const missing = rows.filter((row) => !row.bank_name || !row.bank_account_number)
      if (missing.length)
        throw new ValidationError(
          `${missing.length} pegawai belum memiliki bank atau nomor rekening. Lengkapi sebelum membuat file transfer.`,
        )
      records = rows.map((row) => ({
        bank: row.bank_name,
        nomor_rekening: row.bank_account_number,
        nama_pemilik: row.bank_account_name || row.name,
        nomor_pegawai: row.employee_number,
        nama_pegawai: row.name,
        nominal: Number(row.take_home_pay ?? 0),
        referensi: `${run.number}-${row.employee_number}`,
      }))
      suffix = 'transfer-bank'
    } else if (kind === 'bpjs') {
      records = rows.map((row) => ({
        nomor_pegawai: row.employee_number,
        nama: row.name,
        nik: row.nik,
        nomor_bpjs_kesehatan: row.bpjs_health_number,
        nomor_bpjs_ketenagakerjaan: row.bpjs_employment_number,
        kesehatan_pegawai: Number(row.bpjs_health_employee ?? 0),
        kesehatan_perusahaan: Number(row.bpjs_health_employer ?? 0),
        jht_pegawai: Number(row.bpjs_jht_employee ?? 0),
        jht_perusahaan: Number(row.bpjs_jht_employer ?? 0),
        jp_pegawai: Number(row.bpjs_jp_employee ?? 0),
        jp_perusahaan: Number(row.bpjs_jp_employer ?? 0),
        jkk_perusahaan: Number(row.bpjs_jkk_employer ?? 0),
        jkm_perusahaan: Number(row.bpjs_jkm_employer ?? 0),
      }))
      suffix = 'rekap-bpjs'
    } else if (kind === 'pph21') {
      records = rows.map((row) => ({
        masa_pajak: run.period,
        nomor_pegawai: row.employee_number,
        nama: row.name,
        nik: row.nik,
        npwp: row.npwp,
        status_ptkp: row.ptkp_status,
        kategori_ter: row.ter_category,
        penghasilan_bruto: Number(row.taxable_gross ?? 0),
        tarif_ter: Number(row.ter_rate ?? 0),
        pph_21: Number(row.pph21 ?? 0),
        referensi: `${run.number}-${row.employee_number}`,
      }))
      suffix = 'rekap-pph21'
    } else if (kind === 'payroll') {
      records = rows.map((row) => ({
        nomor_pegawai: row.employee_number,
        nama: row.name,
        gaji_pokok: Number(row.paid_basic_salary ?? row.basic_salary ?? 0),
        gaji_pokok_penuh:Number(row.basic_salary??0),
        hari_eligible:Number(row.eligible_days??0),hari_dasar_prorata:Number(row.period_days??0),rasio_prorata:Number(row.proration_ratio??1),
        tunjangan_tetap: Number(row.paid_fixed_allowance ?? row.fixed_allowance ?? 0),
        tunjangan_variabel: Number(row.variable_allowance ?? 0),
        lembur: Number(row.overtime ?? 0),
        bonus: Number(row.bonus ?? 0),
        thr: Number(row.thr ?? 0),
        rapel: Number(row.rapel ?? 0),
        reimbursement: Number(row.reimbursement ?? 0),
        bruto: Number(row.gross_earnings ?? 0),
        penghasilan_tunai:Number(row.cash_earnings??0),
        fasilitas_noncash:Number(row.noncash_earnings??0),
        biaya_sudah_dicatat_terpisah:Number(row.external_earnings??0),
        komponen_tambahan:Number(row.custom_earnings??0),
        potongan_tambahan:Number(row.custom_deductions??0),
        dasar_pph21:Number(row.taxable_gross??0),
        dasar_bpjs:Number(row.bpjs_salary_base??0),
        hari_kerja:Number(row.planned_days??0),hari_hadir:Number(row.present_days??0),jam_lembur:Number(row.overtime_hours??0),
        bpjs_kesehatan_pegawai: Number(row.bpjs_health_employee ?? 0),
        bpjs_jht_pegawai: Number(row.bpjs_jht_employee ?? 0),
        bpjs_jp_pegawai: Number(row.bpjs_jp_employee ?? 0),
        total_bpjs_pegawai: Number(row.employee_bpjs ?? 0),
        bpjs_kesehatan_perusahaan: Number(row.bpjs_health_employer ?? 0),
        bpjs_jht_perusahaan: Number(row.bpjs_jht_employer ?? 0),
        bpjs_jp_perusahaan: Number(row.bpjs_jp_employer ?? 0),
        bpjs_jkk_perusahaan: Number(row.bpjs_jkk_employer ?? 0),
        bpjs_jkm_perusahaan: Number(row.bpjs_jkm_employer ?? 0),
        total_bpjs_perusahaan: Number(row.employer_bpjs ?? 0),
        pph_21: Number(row.pph21 ?? 0),
        potongan_absensi: Number(row.absence_deduction ?? 0),
        potongan_pinjaman: Number(row.loan_deduction ?? 0),
        potongan_lain: Number(row.other_deduction ?? 0),
        take_home_pay: Number(row.take_home_pay ?? 0),
      }))
      suffix = 'rincian-payroll'
    } else throw new ValidationError('Jenis ekspor payroll tidak dikenal')

    return {
      content: Buffer.from(
        stringify(spreadsheetSafe(records), { header: true, delimiter: ';', bom: true }),
      ),
      contentType: 'text/csv; charset=utf-8',
      filename: `${suffix}-${run.period}.csv`,
    }
  }

  template() {
    const record = {
      nomor_pegawai: 'EMP-001',
      tunjangan_variabel: 0,
      lembur: 0,
      bonus: 0,
      thr: 0,
      rapel: 0,
      reimbursement: 0,
      potongan_absensi: 0,
      potongan_pinjaman: 0,
      potongan_lain: 0,
    }
    return {
      content: Buffer.from(
        stringify(spreadsheetSafe([record]), { header: true, delimiter: ';', bom: true }),
      ),
      contentType: 'text/csv; charset=utf-8',
      filename: 'template-impor-komponen-payroll.csv',
    }
  }

  private async getDraftRun(companyId: number, runId: number) {
    const [runs] = await db.query<Row[]>(
      `SELECT id,number,period,status FROM payroll_runs WHERE id=? AND company_id=?`,
      [runId, companyId],
    )
    if (!runs[0]) throw new NotFoundError('Payroll tidak ditemukan')
    if (runs[0].status !== 'draft')
      throw new ConflictError('Komponen hanya dapat diimpor ketika payroll berstatus Draft')
    return runs[0]
  }

  private validateRows(sourceRows: Record<string, unknown>[], employees: Row[]) {
    const employeeMap = new Map(employees.map((row) => [String(row.employee_number), row]))
    const seen = new Set<string>()
    const components = new Set<string>()
    const rows = sourceRows.map((source, index) => {
      const normalized: Record<string, unknown> = {}
      for (const [header, value] of Object.entries(source)) {
        const field = aliases[normalizeHeader(header)]
        if (field) normalized[field] = value
      }
      const employeeNumber = String(normalized.employee_number ?? '').trim()
      const errors: string[] = []
      if (!employeeNumber) errors.push('Nomor pegawai wajib diisi')
      else if (!employeeMap.has(employeeNumber))
        errors.push('Nomor pegawai tidak ada pada periode ini')
      else if (seen.has(employeeNumber)) errors.push('Nomor pegawai muncul lebih dari satu kali')
      seen.add(employeeNumber)
      const values: Record<string, number> = {}
      for (const field of componentColumns) {
        if (!(field in normalized) || normalized[field] === '') continue
        const amount = parseLocalizedNumber(normalized[field])
        if (amount === null) continue
        if (!Number.isFinite(amount) || amount < 0 || amount > 999_999_999_999)
          errors.push(`${field} harus berupa angka positif yang valid`)
        else {
          values[field] = Math.round(amount * 100) / 100
          components.add(field)
        }
      }
      if (!Object.keys(values).length) errors.push('Tidak ada komponen payroll yang dapat diimpor')
      return {
        source_row: index + 2,
        employee_number: employeeNumber,
        employee_name: employeeMap.get(employeeNumber)?.name ?? null,
        values,
        errors,
      }
    })
    return {
      total_rows: rows.length,
      valid_rows: rows.filter((row) => !row.errors.length).length,
      invalid_rows: rows.filter((row) => row.errors.length).length,
      components: [...components],
      rows,
    }
  }

  async readFile(file: File) {
    if (file.size > 5 * 1024 * 1024) throw new ValidationError('Ukuran file maksimum 5 MB')
    const extension = file.name.toLowerCase().split('.').pop()
    if (extension === 'csv') {
      const text = await file.text()
      try {
        return parse(text, {
          columns: true,
          skip_empty_lines: true,
          trim: true,
          bom: true,
          delimiter: [';', ','],
          relax_column_count: false,
        }) as Record<string, unknown>[]
      } catch {
        throw new ValidationError(
          'CSV tidak dapat dibaca. Gunakan template payroll yang disediakan.',
        )
      }
    }
    if (extension === 'xlsx') {
      const workbook = new ExcelJS.Workbook()
      try {
        await workbook.xlsx.load(await file.arrayBuffer())
      } catch {
        throw new ValidationError('File XLSX tidak dapat dibaca')
      }
      const sheet = workbook.worksheets[0]
      if (!sheet) throw new ValidationError('File XLSX tidak memiliki lembar kerja')
      const headers = (sheet.getRow(1).values as unknown[]).slice(1).map(String)
      const rows: Record<string, unknown>[] = []
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return
        const values = (row.values as unknown[]).slice(1)
        if (!values.some((value) => value !== null && value !== undefined && value !== '')) return
        rows.push(Object.fromEntries(headers.map((header, index) => [header, values[index]])))
      })
      return rows
    }
    throw new ValidationError('Format file harus CSV atau XLSX')
  }
}
