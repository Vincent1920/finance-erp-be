import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { db, transaction } from '../config/database'
import { AuditService } from './AuditService'
import type { PostingContext } from './PostingService'
import { ConflictError, NotFoundError, ValidationError } from '../utils/AppError'
import { addDecimal, subtractDecimal, compareDecimal } from '../utils/decimal'
import type { z } from 'zod'
import type { taxPaymentSchema } from '../validators/tax-reconciliation.validator'
import type {
  TaxDocumentLinkInput,
  TaxReportImportInput,
  TaxResolutionInput,
} from '../validators/tax-reconciliation.validator'

type TaxType =
  'ppn_output' | 'ppn_input' | 'pph' | 'pph21_employee' | 'pph21_non_employee' | 'pph23' | 'pph42'
type SourceRow = {
  id?: number
  source_key: string
  tax_type: TaxType
  document_number: string
  document_date: string
  counterparty_tax_number: string
  counterparty_name: string
  tax_code: string
  dpp: number
  tax_amount: number
  description: string
  source_document_number?: string
  match_document_number?: string
}

type TaxScope = 'all' | 'pph21' | 'ppn' | 'unification'
const taxGroup = (type: TaxType) =>
  type === 'ppn_output' || type === 'ppn_input'
    ? 'ppn'
    : type === 'pph21_employee' || type === 'pph21_non_employee'
      ? 'pph21'
      : 'unification'

const dateOnly = (value: unknown) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '').slice(0, 10)
const number = (value: unknown) => Number(value ?? 0)
const normalizeDocument = (value: unknown) =>
  String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
const normalizeTaxNumber = (value: unknown) => String(value ?? '').replace(/\D/g, '')
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100

function mappedRow(row: RowDataPacket, sourceKey?: string): SourceRow {
  return {
    id: row.id ? Number(row.id) : undefined,
    source_key: sourceKey ?? String(row.source_key ?? `SPT-${row.id}`),
    tax_type: String(row.tax_type) as TaxType,
    document_number: String(row.document_number ?? ''),
    document_date: dateOnly(row.document_date),
    counterparty_tax_number: String(row.counterparty_tax_number ?? ''),
    counterparty_name: String(row.counterparty_name ?? ''),
    tax_code: String(row.tax_code ?? ''),
    dpp: number(row.dpp),
    tax_amount: number(row.tax_amount),
    description: String(row.description ?? ''),
  }
}

export class TaxReconciliationService {
  async version(companyId: number, id: number) {
    const [rows] = await db.execute<RowDataPacket[]>(
      'SELECT * FROM tax_report_versions WHERE company_id=? AND id=?',
      [companyId, id],
    )
    if (!rows[0]) throw new NotFoundError('Versi SPT tidak ditemukan')
    return rows[0]
  }
  private completeness(row: SourceRow, period: string, requireTaxDocument = false) {
    const issues: string[] = []
    const identity = normalizeTaxNumber(row.counterparty_tax_number)
    const documentNumber = requireTaxDocument ? row.match_document_number : row.document_number
    if (!normalizeDocument(documentNumber)) issues.push('Nomor faktur/bukti potong belum diisi')
    if (!row.document_date || row.document_date.slice(0, 7) !== period)
      issues.push('Tanggal dokumen tidak sesuai masa pajak')
    if (!identity) issues.push('NPWP/NIK belum diisi')
    else if (identity.length !== 16) issues.push('NPWP/NIK harus 16 digit')
    if (!row.counterparty_name.trim()) issues.push('Nama lawan transaksi belum diisi')
    if (!row.tax_code.trim()) issues.push('Kode pajak belum diisi')
    if (!Number.isFinite(row.dpp) || row.dpp === 0) issues.push('DPP harus terisi dan bukan nol')
    if (!Number.isFinite(row.tax_amount)) issues.push('Nilai pajak tidak valid')
    if (row.dpp && row.tax_amount && Math.sign(row.dpp) !== Math.sign(row.tax_amount))
      issues.push('Arah DPP dan pajak tidak sama')
    if (row.dpp && Math.abs(row.tax_amount / row.dpp) > 1)
      issues.push('Tarif efektif melebihi 100%')
    return { status: issues.length ? 'incomplete' : 'complete', issues }
  }
  private async systemRows(companyId: number, period: string) {
    const start = `${period}-01`
    const end = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 1))
      .toISOString()
      .slice(0, 10)
    const params = [companyId, start, end]
    const [sales] = await db.execute<RowDataPacket[]>(
      `SELECT CONCAT('SI-',h.id) source_key,'ppn_output' tax_type,h.invoice_number document_number,
        h.invoice_date document_date,c.tax_number counterparty_tax_number,c.name counterparty_name,
        GROUP_CONCAT(DISTINCT tc.code ORDER BY tc.code SEPARATOR ', ') tax_code,
        SUM(l.base_subtotal) dpp,SUM(l.base_tax_amount) tax_amount,'Invoice penjualan' description
       FROM sales_invoices h JOIN sales_invoice_lines l ON l.sales_invoice_id=h.id
       JOIN customers c ON c.id=h.customer_id JOIN tax_codes tc ON tc.id=l.tax_code_id AND tc.tax_type='vat'
       WHERE h.company_id=? AND h.invoice_date>=? AND h.invoice_date<?
         AND h.status IN ('posted','partially_paid','paid') AND l.base_tax_amount<>0
       GROUP BY h.id,h.invoice_number,h.invoice_date,c.tax_number,c.name`,
      params,
    )
    const [purchases] = await db.execute<RowDataPacket[]>(
      `SELECT CONCAT('PI-',h.id) source_key,'ppn_input' tax_type,
        COALESCE(NULLIF(h.supplier_invoice_number,''),h.invoice_number) document_number,
        h.invoice_date document_date,s.tax_number counterparty_tax_number,s.name counterparty_name,
        GROUP_CONCAT(DISTINCT tc.code ORDER BY tc.code SEPARATOR ', ') tax_code,
        SUM(l.base_subtotal) dpp,SUM(l.base_tax_amount) tax_amount,'Invoice pembelian' description
       FROM purchase_invoices h JOIN purchase_invoice_lines l ON l.purchase_invoice_id=h.id
       JOIN suppliers s ON s.id=h.supplier_id JOIN tax_codes tc ON tc.id=l.tax_code_id AND tc.tax_type='vat'
       WHERE h.company_id=? AND h.invoice_date>=? AND h.invoice_date<?
         AND h.status IN ('posted','partially_paid','paid') AND l.base_tax_amount<>0
       GROUP BY h.id,h.invoice_number,h.supplier_invoice_number,h.invoice_date,s.tax_number,s.name`,
      params,
    )
    const [withholding] = await db.execute<RowDataPacket[]>(
      `SELECT CONCAT('PPh-PI-',h.id,'-',tc.id) source_key,
        CASE WHEN tc.reporting_type IN ('pph21_employee','pph21_non_employee','pph23','pph42')
          THEN tc.reporting_type ELSE CASE
            WHEN UPPER(CONCAT(tc.code,' ',tc.name)) LIKE '%PPh 21%' OR UPPER(tc.code) LIKE '%PPH21%' THEN 'pph21_non_employee'
            WHEN UPPER(CONCAT(tc.code,' ',tc.name)) LIKE '%4(2)%' OR UPPER(tc.code) LIKE '%PPH42%' OR UPPER(CONCAT(tc.code,' ',tc.name)) LIKE '%FINAL%' THEN 'pph42'
            ELSE 'pph23'
          END
        END tax_type,
        COALESCE(NULLIF(h.supplier_invoice_number,''),h.invoice_number) document_number,
        h.invoice_date document_date,s.tax_number counterparty_tax_number,s.name counterparty_name,
        tc.code tax_code,SUM(l.base_subtotal) dpp,SUM(l.base_withholding_amount) tax_amount,
        'PPh dipotong pada invoice pembelian' description
       FROM purchase_invoices h JOIN purchase_invoice_lines l ON l.purchase_invoice_id=h.id
       JOIN suppliers s ON s.id=h.supplier_id
       JOIN tax_codes tc ON tc.id=l.withholding_tax_id AND tc.tax_type='withholding'
       WHERE h.company_id=? AND h.invoice_date>=? AND h.invoice_date<?
         AND h.status IN ('posted','partially_paid','paid') AND l.withholding_amount<>0
       GROUP BY h.id,h.invoice_number,h.supplier_invoice_number,h.invoice_date,s.tax_number,s.name,tc.id,tc.code,tc.reporting_type,tc.name`,
      params,
    )
    const [salesReturns] = await db.execute<RowDataPacket[]>(
      `SELECT CONCAT('SR-',h.id) source_key,'ppn_output' tax_type,h.return_number document_number,
        h.return_date document_date,c.tax_number counterparty_tax_number,c.name counterparty_name,
        GROUP_CONCAT(DISTINCT tc.code ORDER BY tc.code SEPARATOR ', ') tax_code,
        -SUM(l.base_subtotal) dpp,-SUM(ROUND(l.tax_amount*h.exchange_rate,2)) tax_amount,'Retur penjualan' description
       FROM sales_returns h JOIN sales_return_lines l ON l.sales_return_id=h.id
       JOIN customers c ON c.id=h.customer_id JOIN tax_codes tc ON tc.id=l.tax_code_id AND tc.tax_type='vat'
       WHERE h.company_id=? AND h.return_date>=? AND h.return_date<? AND h.status='posted'
       GROUP BY h.id,h.return_number,h.return_date,c.tax_number,c.name`,
      params,
    )
    const [purchaseReturns] = await db.execute<RowDataPacket[]>(
      `SELECT CONCAT('PR-',h.id) source_key,'ppn_input' tax_type,h.return_number document_number,
        h.return_date document_date,s.tax_number counterparty_tax_number,s.name counterparty_name,
        GROUP_CONCAT(DISTINCT tc.code ORDER BY tc.code SEPARATOR ', ') tax_code,
        -SUM(l.base_subtotal) dpp,-SUM(ROUND(l.tax_amount*h.exchange_rate,2)) tax_amount,'Retur pembelian' description
       FROM purchase_returns h JOIN purchase_return_lines l ON l.purchase_return_id=h.id
       JOIN suppliers s ON s.id=h.supplier_id JOIN tax_codes tc ON tc.id=l.tax_code_id AND tc.tax_type='vat'
       WHERE h.company_id=? AND h.return_date>=? AND h.return_date<? AND h.status='posted'
       GROUP BY h.id,h.return_number,h.return_date,s.tax_number,s.name`,
      params,
    )
    const automatic = [
      ...sales,
      ...purchases,
      ...withholding,
      ...salesReturns,
      ...purchaseReturns,
    ].map((row) => mappedRow(row))
    const [manual] = await db.execute<RowDataPacket[]>(
      `SELECT CONCAT('INTERNAL-',r.id) source_key,r.tax_type,r.document_number,r.document_date,
        r.counterparty_tax_number,r.counterparty_name,r.tax_code,r.dpp,r.tax_amount,r.description
       FROM tax_internal_rows r JOIN tax_reconciliation_periods p ON p.id=r.period_id
       WHERE r.company_id=? AND p.tax_period=?`,
      [companyId, period],
    )
    const combined = [...automatic, ...manual.map((row) => mappedRow(row))]
    const [links] = await db.execute<RowDataPacket[]>(
      `SELECT source_key,tax_document_number,tax_document_date FROM tax_document_links
       WHERE company_id=? AND source_key IN (${combined.length ? combined.map(() => '?').join(',') : "''"})`,
      combined.length ? [companyId, ...combined.map((row) => row.source_key)] : [companyId],
    )
    const linkMap = new Map(links.map((row) => [String(row.source_key), row]))
    return combined.map((row) => {
      const link = linkMap.get(row.source_key)
      return {
        ...row,
        source_document_number: row.document_number,
        match_document_number: link
          ? String(link.tax_document_number)
          : row.source_key.startsWith('INTERNAL-')
            ? row.document_number
            : '',
        document_date: link?.tax_document_date
          ? dateOnly(link.tax_document_date)
          : row.document_date,
      }
    })
  }

  private async bookTotals(companyId: number, period: string) {
    const start = `${period}-01`
    const end = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 1))
      .toISOString()
      .slice(0, 10)
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT
        SUM(CASE WHEN a.account_type='revenue' THEN jl.credit-jl.debit ELSE 0 END) revenue,
        SUM(CASE WHEN a.account_type IN ('expense','cogs') THEN jl.debit-jl.credit ELSE 0 END) expense
       FROM journals j JOIN journal_lines jl ON jl.journal_id=j.id JOIN accounts a ON a.id=jl.account_id
       WHERE j.company_id=? AND j.status IN ('posted','reversed') AND j.journal_date>=? AND j.journal_date<?`,
      [companyId, start, end],
    )
    const [taxAccounts] = await db.execute<RowDataPacket[]>(
      `SELECT a.code,a.name,
        COALESCE(SUM(CASE WHEN j.journal_date<? THEN jl.debit-jl.credit ELSE 0 END),0) opening_balance,
        COALESCE(SUM(CASE WHEN j.journal_date>=? THEN jl.debit ELSE 0 END),0) period_debit,
        COALESCE(SUM(CASE WHEN j.journal_date>=? THEN jl.credit ELSE 0 END),0) period_credit,
        COALESCE(SUM(CASE WHEN j.id IS NOT NULL THEN jl.debit-jl.credit ELSE 0 END),0) closing_balance
       FROM accounts a LEFT JOIN journal_lines jl ON jl.account_id=a.id
       LEFT JOIN journals j ON j.id=jl.journal_id AND j.company_id=? AND j.status IN ('posted','reversed') AND j.journal_date<?
       WHERE a.company_id=? AND a.id IN (
         SELECT input_tax_account_id FROM tax_codes WHERE company_id=? UNION SELECT output_tax_account_id FROM tax_codes WHERE company_id=?
         UNION SELECT pph21_payable_account_id FROM payroll_policies WHERE company_id=?
         UNION SELECT account_id FROM account_mappings WHERE company_id=? AND mapping_key IN ('INPUT_VAT','OUTPUT_VAT','WITHHOLDING_TAX'))
       GROUP BY a.id,a.code,a.name ORDER BY a.code`,
      [start, start, start, companyId, end, companyId, companyId, companyId, companyId, companyId],
    )
    return {
      revenue: number(rows[0]?.revenue),
      expense: number(rows[0]?.expense),
      taxAccounts: taxAccounts.map((row) => ({
        code: String(row.code),
        name: String(row.name),
        opening_balance: number(row.opening_balance),
        period_debit: number(row.period_debit),
        period_credit: number(row.period_credit),
        closing_balance: number(row.closing_balance),
        balance: number(row.period_debit) - number(row.period_credit),
      })),
    }
  }

  async overview(companyId: number, period: string, scope: TaxScope) {
    const system = (await this.systemRows(companyId, period)).filter((row) =>
      scope === 'all' ? true : taxGroup(row.tax_type) === scope,
    )
    const [periodRows] = await db.execute<RowDataPacket[]>(
      'SELECT * FROM tax_reconciliation_periods WHERE company_id=? AND tax_period=? LIMIT 1',
      [companyId, period],
    )
    const periodRow = periodRows[0]
    let reported: SourceRow[] = []
    let resolutions: RowDataPacket[] = []
    if (periodRow) {
      const [reportRows] = await db.execute<RowDataPacket[]>(
        `SELECT * FROM tax_report_rows WHERE company_id=? AND period_id=?
         ${scope === 'ppn' ? "AND tax_type IN ('ppn_output','ppn_input')" : scope === 'pph21' ? "AND tax_type IN ('pph21_employee','pph21_non_employee')" : scope === 'unification' ? "AND tax_type IN ('pph','pph23','pph42')" : ''}
         ORDER BY document_date,document_number,id`,
        [companyId, periodRow.id],
      )
      reported = reportRows.map((row) => mappedRow(row))
      const [resolutionRows] = await db.execute<RowDataPacket[]>(
        'SELECT * FROM tax_reconciliation_resolutions WHERE company_id=? AND period_id=?',
        [companyId, periodRow.id],
      )
      resolutions = resolutionRows
    }
    const resolutionMap = new Map(resolutions.map((row) => [String(row.match_key), row]))
    const available = new Set(reported.map((_, index) => index))
    const comparisons: Record<string, unknown>[] = []
    for (const systemRow of system) {
      const systemCompleteness = this.completeness(systemRow, period, true)
      const doc = normalizeDocument(systemRow.match_document_number)
      let matchMethod = ''
      let matchIndex = doc
        ? reported.findIndex(
            (row, index) =>
              available.has(index) &&
              row.tax_type === systemRow.tax_type &&
              normalizeDocument(row.document_number) === doc,
          )
        : -1
      if (matchIndex >= 0) matchMethod = 'document_number'
      if (matchIndex < 0) {
        matchIndex = reported.findIndex(
          (row, index) =>
            available.has(index) &&
            row.tax_type === systemRow.tax_type &&
            normalizeTaxNumber(row.counterparty_tax_number) ===
              normalizeTaxNumber(systemRow.counterparty_tax_number) &&
            Math.abs(row.dpp - systemRow.dpp) <= 1 &&
            Math.abs(row.tax_amount - systemRow.tax_amount) <= 1,
        )
        if (matchIndex >= 0) matchMethod = 'identity_amount'
      }
      const reportRow = matchIndex >= 0 ? reported[matchIndex] : undefined
      const reportCompleteness = reportRow ? this.completeness(reportRow, period) : null
      if (matchIndex >= 0) available.delete(matchIndex)
      const matchKey = reportRow
        ? `${systemRow.tax_type}|${doc || normalizeDocument(reportRow.document_number)}`
        : `${systemRow.tax_type}|SYSTEM|${systemRow.source_key}`
      const taxNumberMismatch = Boolean(
        reportRow &&
        normalizeTaxNumber(reportRow.counterparty_tax_number) &&
        normalizeTaxNumber(systemRow.counterparty_tax_number) &&
        normalizeTaxNumber(reportRow.counterparty_tax_number) !==
          normalizeTaxNumber(systemRow.counterparty_tax_number),
      )
      const dppDifference = round((reportRow?.dpp ?? 0) - systemRow.dpp)
      const taxDifference = round((reportRow?.tax_amount ?? 0) - systemRow.tax_amount)
      const status = !reportRow
        ? 'system_only'
        : taxNumberMismatch
          ? 'identity_mismatch'
          : Math.abs(dppDifference) > 1 || Math.abs(taxDifference) > 1
            ? 'amount_mismatch'
            : 'matched'
      const resolution = resolutionMap.get(matchKey)
      comparisons.push({
        match_key: matchKey,
        status,
        tax_group: taxGroup(systemRow.tax_type),
        tax_type: systemRow.tax_type,
        source_key: systemRow.source_key,
        source_document_number: systemRow.source_document_number,
        document_number: systemRow.match_document_number || reportRow?.document_number || '',
        match_method: matchMethod,
        document_date: systemRow.document_date,
        counterparty_name: systemRow.counterparty_name || reportRow?.counterparty_name,
        counterparty_tax_number:
          systemRow.counterparty_tax_number || reportRow?.counterparty_tax_number,
        tax_code: systemRow.tax_code || reportRow?.tax_code,
        system_dpp: systemRow.dpp,
        reported_dpp: reportRow?.dpp ?? 0,
        dpp_difference: dppDifference,
        system_tax: systemRow.tax_amount,
        reported_tax: reportRow?.tax_amount ?? 0,
        tax_difference: taxDifference,
        source_description: systemRow.description,
        resolution_code: resolution?.resolution_code ?? 'pending',
        resolution_note: resolution?.note ?? '',
        completeness_status:
          systemCompleteness.status === 'complete' &&
          (!reportCompleteness || reportCompleteness.status === 'complete')
            ? 'complete'
            : 'incomplete',
        validation_issues: [
          ...systemCompleteness.issues.map((issue) => `Finora: ${issue}`),
          ...(reportCompleteness?.issues ?? []).map((issue) => `SPT: ${issue}`),
        ],
      })
    }
    for (const index of available) {
      const reportRow = reported[index]!
      const matchKey = `${reportRow.tax_type}|SPT|${reportRow.id}`
      const resolution = resolutionMap.get(matchKey)
      comparisons.push({
        match_key: matchKey,
        status: 'reported_only',
        tax_group: taxGroup(reportRow.tax_type),
        tax_type: reportRow.tax_type,
        source_key: '',
        source_document_number: '',
        document_number: reportRow.document_number,
        match_method: '',
        document_date: reportRow.document_date,
        counterparty_name: reportRow.counterparty_name,
        counterparty_tax_number: reportRow.counterparty_tax_number,
        tax_code: reportRow.tax_code,
        system_dpp: 0,
        reported_dpp: reportRow.dpp,
        dpp_difference: reportRow.dpp,
        system_tax: 0,
        reported_tax: reportRow.tax_amount,
        tax_difference: reportRow.tax_amount,
        source_description: reportRow.description,
        resolution_code: resolution?.resolution_code ?? 'pending',
        resolution_note: resolution?.note ?? '',
        completeness_status: this.completeness(reportRow, period).status,
        validation_issues: this.completeness(reportRow, period).issues.map(
          (issue) => `SPT: ${issue}`,
        ),
      })
    }
    const types: TaxType[] = [
      'ppn_output',
      'ppn_input',
      'pph',
      'pph21_employee',
      'pph21_non_employee',
      'pph23',
      'pph42',
    ]
    const totals = Object.fromEntries(
      types.map((type) => {
        const systemRows = system.filter((row) => row.tax_type === type)
        const reportRows = reported.filter((row) => row.tax_type === type)
        const systemDpp = systemRows.reduce((sum, row) => sum + row.dpp, 0)
        const systemTax = systemRows.reduce((sum, row) => sum + row.tax_amount, 0)
        const reportedDpp = reportRows.reduce((sum, row) => sum + row.dpp, 0)
        const reportedTax = reportRows.reduce((sum, row) => sum + row.tax_amount, 0)
        return [
          type,
          {
            system_dpp: round(systemDpp),
            system_tax: round(systemTax),
            reported_dpp: round(reportedDpp),
            reported_tax: round(reportedTax),
            dpp_difference: round(reportedDpp - systemDpp),
            tax_difference: round(reportedTax - systemTax),
            system_documents: systemRows.length,
            reported_documents: reportRows.length,
          },
        ]
      }),
    )
    const groupMembers: Record<'pph21' | 'ppn' | 'unification', TaxType[]> = {
      pph21: ['pph21_employee', 'pph21_non_employee'],
      ppn: ['ppn_output', 'ppn_input'],
      unification: ['pph', 'pph23', 'pph42'],
    }
    const groups = Object.fromEntries(
      Object.entries(groupMembers).map(([group, members]) => {
        const add = (field: string) =>
          round(
            members.reduce(
              (sum, type) => sum + number((totals[type] as Record<string, number>)[field]),
              0,
            ),
          )
        return [
          group,
          {
            system_dpp: add('system_dpp'),
            system_tax: add('system_tax'),
            reported_dpp: add('reported_dpp'),
            reported_tax: add('reported_tax'),
            dpp_difference: add('dpp_difference'),
            tax_difference: add('tax_difference'),
            system_documents: add('system_documents'),
            reported_documents: add('reported_documents'),
          },
        ]
      }),
    )
    const book = await this.bookTotals(companyId, period)
    const [versions] = await db.execute<RowDataPacket[]>(
      'SELECT id,revision,source_file,reason,created_at FROM tax_report_versions WHERE company_id=? AND period_id=? ORDER BY id DESC',
      [companyId, periodRow?.id ?? 0],
    )
    const [payments] = await db.execute<RowDataPacket[]>(
      `SELECT p.*,j.journal_number,j.status journal_status,a.code account_code,a.name account_name FROM tax_payment_evidence p JOIN journals j ON j.id=p.journal_id JOIN accounts a ON a.id=p.account_id WHERE p.company_id=? AND p.tax_period=? ORDER BY p.payment_date,p.id`,
      [companyId, period],
    )
    const paymentSummary = Object.fromEntries(
      ['ppn', 'pph21', 'unification']
        .filter((group) => scope === 'all' || group === scope)
        .map((group) => {
          const paid = addDecimal(
            payments
              .filter((p) => p.tax_group === group && p.journal_status === 'posted')
              .map((p) => String(p.amount)),
          )
          const output = totals.ppn_output as Record<string, number>,
            input = totals.ppn_input as Record<string, number>
          const target =
            group === 'ppn'
              ? subtractDecimal(output.reported_tax ?? 0, input.reported_tax ?? 0)
              : String((groups[group] as Record<string, number>).reported_tax ?? 0)
          return [
            group,
            {
              reported_net_tax: target,
              linked_payment: paid,
              difference: subtractDecimal(target, paid),
              invalid_evidence: payments.filter(
                (p) => p.tax_group === group && p.journal_status !== 'posted',
              ).length,
            },
          ]
        }),
    )
    const ppnOutput = totals.ppn_output as Record<string, number>
    const ppnInput = totals.ppn_input as Record<string, number>
    const pph21 = groups.pph21 as Record<string, number>
    const unification = groups.unification as Record<string, number>
    const equalizations = [
      {
        group: 'pph21',
        key: 'pph21',
        label: 'Data payroll/honorarium vs bukti potong PPh 21',
        book_amount: pph21.system_tax,
        tax_amount: pph21.reported_tax,
        difference: pph21.tax_difference,
      },
      {
        group: 'ppn',
        key: 'revenue',
        label: 'Pendapatan buku besar vs DPP faktur pajak keluaran',
        book_amount: round(book.revenue),
        tax_amount: ppnOutput.system_dpp,
        difference: round(ppnOutput.system_dpp - book.revenue),
      },
      {
        group: 'ppn',
        key: 'expense_ppn',
        label: 'Beban/HPP buku besar vs DPP faktur pajak masukan',
        book_amount: round(book.expense),
        tax_amount: ppnInput.system_dpp,
        difference: round(ppnInput.system_dpp - book.expense),
      },
      {
        group: 'ppn',
        key: 'ppn_output',
        label: 'Faktur pajak keluaran Finora vs SPT PPN',
        book_amount: ppnOutput.system_tax,
        tax_amount: ppnOutput.reported_tax,
        difference: ppnOutput.tax_difference,
      },
      {
        group: 'ppn',
        key: 'ppn_input',
        label: 'Faktur pajak masukan Finora vs SPT PPN',
        book_amount: ppnInput.system_tax,
        tax_amount: ppnInput.reported_tax,
        difference: ppnInput.tax_difference,
      },
      {
        group: 'unification',
        key: 'unification_base',
        label: 'Beban/HPP buku besar vs objek PPh 23 dan PPh 4(2)',
        book_amount: round(book.expense),
        tax_amount: unification.system_dpp,
        difference: round(unification.system_dpp - book.expense),
      },
      {
        group: 'unification',
        key: 'unification',
        label: 'Bukti potong PPh Unifikasi Finora vs SPT',
        book_amount: unification.system_tax,
        tax_amount: unification.reported_tax,
        difference: unification.tax_difference,
      },
    ]
    const matched = comparisons.filter((row) => row.status === 'matched').length
    const resolved = comparisons.filter(
      (row) => row.status !== 'matched' && row.resolution_code !== 'pending',
    ).length
    const readiness = comparisons.length
      ? Math.round(((matched + resolved) / comparisons.length) * 100)
      : 0
    const incomplete = comparisons.filter((row) => row.completeness_status === 'incomplete').length
    return {
      period: periodRow
        ? {
            id: Number(periodRow.id),
            tax_period: String(periodRow.tax_period),
            revision: Number(periodRow.revision),
            status: String(periodRow.status),
            source_file: periodRow.source_file,
            notes: periodRow.notes,
            imported_at: periodRow.imported_at,
            reviewed_at: periodRow.reviewed_at,
            locked_at: periodRow.locked_at,
          }
        : { id: null, tax_period: period, revision: 0, status: 'open', source_file: null },
      summary: {
        readiness,
        total: comparisons.length,
        matched,
        resolved,
        exceptions: comparisons.length - matched - resolved,
        incomplete,
      },
      totals,
      groups,
      equalizations,
      tax_accounts: book.taxAccounts,
      versions,
      payments,
      payment_summary: paymentSummary,
      imported_rows: reported.map((row) => ({
        ...row,
        tax_group: taxGroup(row.tax_type),
        completeness_status: this.completeness(row, period).status,
        validation_issues: this.completeness(row, period).issues,
      })),
      rows: comparisons,
    }
  }

  async importReport(companyId: number, input: TaxReportImportInput, context: PostingContext) {
    return transaction(async (connection) => {
      const periodId = await this.ensurePeriod(connection, companyId, input.period, context.userId)
      const [periodRows] = await connection.execute<RowDataPacket[]>(
        'SELECT * FROM tax_reconciliation_periods WHERE id=? AND company_id=? FOR UPDATE',
        [periodId, companyId],
      )
      if (periodRows[0]?.status === 'locked') throw new ConflictError('Masa pajak sudah dikunci')
      if (input.revision !== Number(periodRows[0]!.revision))
        throw new ConflictError(
          'Gunakan nomor revisi aktif. Mulai pembetulan untuk menaikkan revisi SPT.',
        )
      const [previous] = await connection.execute<RowDataPacket[]>(
        'SELECT * FROM tax_report_rows WHERE company_id=? AND period_id=?',
        [companyId, periodId],
      )
      if (previous.length) {
        if (input.notes.trim().length < 10)
          throw new ValidationError('Impor pengganti wajib menyertakan alasan minimal 10 karakter')
        await connection.execute(
          `INSERT INTO tax_report_versions(company_id,period_id,revision,source_file,snapshot,reason,created_by) VALUES(?,?,?,?,?,?,?)`,
          [
            companyId,
            periodId,
            periodRows[0]!.revision,
            periodRows[0]!.source_file,
            JSON.stringify(previous),
            input.notes,
            context.userId,
          ],
        )
      }
      const documentKeys = new Set<string>()
      for (const row of input.rows) {
        const key = `${row.tax_type}|${normalizeDocument(row.document_number)}`
        if (documentKeys.has(key))
          throw new ValidationError(`Nomor dokumen SPT ganda: ${row.document_number}`)
        documentKeys.add(key)
        if (row.document_date.slice(0, 7) !== input.period)
          throw new ValidationError(
            `Tanggal dokumen ${row.document_number} tidak sesuai masa pajak`,
          )
      }
      // Old explanations must not silently resolve a new replacement SPT.
      await connection.execute(
        'DELETE FROM tax_reconciliation_resolutions WHERE company_id=? AND period_id=?',
        [companyId, periodId],
      )
      await connection.execute('DELETE FROM tax_report_rows WHERE company_id=? AND period_id=?', [
        companyId,
        periodId,
      ])
      for (let offset = 0; offset < input.rows.length; offset += 500) {
        const chunk = input.rows.slice(offset, offset + 500)
        const values = chunk.flatMap((row) => [
          companyId,
          periodId,
          row.tax_type,
          row.document_number,
          row.document_date,
          row.counterparty_tax_number ?? null,
          row.counterparty_name ?? null,
          row.tax_code ?? null,
          row.dpp,
          row.tax_amount,
          row.description ?? null,
          context.userId,
        ])
        await connection.query(
          `INSERT INTO tax_report_rows(company_id,period_id,tax_type,document_number,document_date,counterparty_tax_number,counterparty_name,tax_code,dpp,tax_amount,description,created_by)
           VALUES ${chunk.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?)').join(',')}`,
          values,
        )
      }
      await connection.execute(
        `UPDATE tax_reconciliation_periods SET revision=?,status='open',source_file=?,notes=?,imported_by=?,imported_at=NOW(),reviewed_by=NULL,reviewed_at=NULL,locked_by=NULL,locked_at=NULL WHERE id=?`,
        [input.revision, input.source_file, input.notes || null, context.userId, periodId],
      )
      await new AuditService().log(connection, {
        companyId,
        userId: context.userId,
        module: 'tax-reconciliation',
        action: 'import',
        recordType: 'tax_reconciliation_period',
        recordId: periodId,
        recordNumber: input.period,
        newValue: {
          rows: input.rows.length,
          sourceFile: input.source_file,
          revision: input.revision,
        },
      })
      return { periodId, rows: input.rows.length }
    })
  }

  async importInternal(companyId: number, input: TaxReportImportInput, context: PostingContext) {
    return transaction(async (connection) => {
      const periodId = await this.ensurePeriod(connection, companyId, input.period, context.userId)
      const [periodRows] = await connection.execute<RowDataPacket[]>(
        'SELECT status,imported_at FROM tax_reconciliation_periods WHERE id=? AND company_id=? FOR UPDATE',
        [periodId, companyId],
      )
      if (periodRows[0]?.status === 'locked') throw new ConflictError('Masa pajak sudah dikunci')
      await connection.execute('DELETE FROM tax_internal_rows WHERE company_id=? AND period_id=?', [
        companyId,
        periodId,
      ])
      for (let offset = 0; offset < input.rows.length; offset += 500) {
        const chunk = input.rows.slice(offset, offset + 500)
        const values = chunk.flatMap((row) => [
          companyId,
          periodId,
          row.tax_type,
          row.document_number,
          row.document_date,
          row.counterparty_tax_number ?? null,
          row.counterparty_name ?? null,
          row.tax_code ?? null,
          row.dpp,
          row.tax_amount,
          row.description ?? null,
          context.userId,
        ])
        await connection.query(
          `INSERT INTO tax_internal_rows(company_id,period_id,tax_type,document_number,document_date,counterparty_tax_number,counterparty_name,tax_code,dpp,tax_amount,description,created_by)
           VALUES ${chunk.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?)').join(',')}`,
          values,
        )
      }
      await new AuditService().log(connection, {
        companyId,
        userId: context.userId,
        module: 'tax-reconciliation',
        action: 'import',
        recordType: 'tax_internal_period',
        recordId: periodId,
        recordNumber: input.period,
        newValue: { rows: input.rows.length, sourceFile: input.source_file },
      })
      return { periodId, rows: input.rows.length }
    })
  }

  async linkDocument(companyId: number, input: TaxDocumentLinkInput, context: PostingContext) {
    return transaction(async (connection) => {
      const sourcePeriod = await this.sourcePeriod(connection, companyId, input.source_key)
      const periodId = await this.ensurePeriod(connection, companyId, sourcePeriod, context.userId)
      const [locked] = await connection.execute<RowDataPacket[]>(
        'SELECT status FROM tax_reconciliation_periods WHERE id=? FOR UPDATE',
        [periodId],
      )
      if (locked[0]?.status === 'locked')
        throw new ConflictError(
          'Masa pajak sudah dikunci; mulai pembetulan sebelum mengubah bukti/faktur',
        )
      const [old] = await connection.execute<RowDataPacket[]>(
        'SELECT * FROM tax_document_links WHERE company_id=? AND source_key=? FOR UPDATE',
        [companyId, input.source_key],
      )
      await connection.execute(
        `INSERT INTO tax_document_links(company_id,source_key,tax_document_number,tax_document_date,notes,updated_by)
       VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE tax_document_number=VALUES(tax_document_number),
       tax_document_date=VALUES(tax_document_date),notes=VALUES(notes),updated_by=VALUES(updated_by),updated_at=NOW()`,
        [
          companyId,
          input.source_key,
          input.tax_document_number,
          input.tax_document_date ?? null,
          input.notes || null,
          context.userId,
        ],
      )
      await new AuditService().log(connection, {
        companyId,
        userId: context.userId,
        module: 'tax-reconciliation',
        action: 'update',
        recordType: 'tax_document_link',
        recordId: periodId,
        oldValue: old[0] ?? null,
        newValue: input,
      })
      return { sourceKey: input.source_key, taxDocumentNumber: input.tax_document_number }
    })
  }

  async resolve(companyId: number, input: TaxResolutionInput, context: PostingContext) {
    if (input.resolution_code !== 'pending' && input.note.trim().length < 10)
      throw new ValidationError('Penjelasan selisih wajib diisi minimal 10 karakter')
    return transaction(async (connection) => {
      const periodId = await this.ensurePeriod(connection, companyId, input.period, context.userId)
      const [periodRows] = await connection.execute<RowDataPacket[]>(
        'SELECT status FROM tax_reconciliation_periods WHERE id=? FOR UPDATE',
        [periodId],
      )
      if (periodRows[0]?.status === 'locked') throw new ConflictError('Masa pajak sudah dikunci')
      await connection.execute(
        `INSERT INTO tax_reconciliation_resolutions(company_id,period_id,match_key,resolution_code,note,resolved_by)
         VALUES(?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE resolution_code=VALUES(resolution_code),note=VALUES(note),resolved_by=VALUES(resolved_by),resolved_at=NOW()`,
        [
          companyId,
          periodId,
          input.match_key,
          input.resolution_code,
          input.note || null,
          context.userId,
        ],
      )
      return { matchKey: input.match_key, resolutionCode: input.resolution_code }
    })
  }

  async setStatus(
    companyId: number,
    period: string,
    status: 'open' | 'reviewed' | 'locked',
    context: PostingContext,
  ) {
    if (status === 'locked') {
      const overview = await this.overview(companyId, period, 'all')
      if (overview.summary.exceptions > 0)
        throw new ValidationError('Selesaikan seluruh selisih sebelum mengunci masa pajak')
      if (overview.summary.incomplete > 0)
        throw new ValidationError(
          'Lengkapi identitas, nomor dokumen, kode pajak, DPP, dan nilai pajak sebelum mengunci masa',
        )
    }
    return transaction(async (connection) => {
      const periodId = await this.ensurePeriod(connection, companyId, period, context.userId)
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT status,imported_at FROM tax_reconciliation_periods WHERE id=? AND company_id=? FOR UPDATE',
        [periodId, companyId],
      )
      if (!rows[0]) throw new NotFoundError('Masa rekonsiliasi tidak ditemukan')
      if (status === 'locked' && !rows[0].imported_at)
        throw new ConflictError('Impor SPT untuk versi aktif sebelum mengunci masa pajak')
      if (rows[0].status === 'locked' && status !== 'locked')
        throw new ConflictError('Masa pajak yang sudah dikunci tidak dapat dibuka dari layar ini')
      await connection.execute(
        `UPDATE tax_reconciliation_periods SET status=?,
         reviewed_by=IF(?='reviewed',?,reviewed_by),reviewed_at=IF(?='reviewed',NOW(),reviewed_at),
         locked_by=IF(?='locked',?,locked_by),locked_at=IF(?='locked',NOW(),locked_at) WHERE id=?`,
        [status, status, context.userId, status, status, context.userId, status, periodId],
      )
      await new AuditService().log(connection, {
        companyId,
        userId: context.userId,
        module: 'tax-reconciliation',
        action: status === 'locked' ? 'lock' : 'update',
        recordType: 'tax_reconciliation_period',
        recordId: periodId,
        recordNumber: period,
        newValue: { status },
      })
      return { periodId, status }
    })
  }

  private async ensurePeriod(
    connection: PoolConnection,
    companyId: number,
    period: string,
    userId: number,
  ) {
    await connection.execute(
      `INSERT INTO tax_reconciliation_periods(company_id,tax_period,imported_by) VALUES(?,?,?)
       ON DUPLICATE KEY UPDATE tax_period=VALUES(tax_period)`,
      [companyId, period, userId],
    )
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT id FROM tax_reconciliation_periods WHERE company_id=? AND tax_period=? LIMIT 1',
      [companyId, period],
    )
    return Number(rows[0]!.id)
  }

  private async sourcePeriod(connection: PoolConnection, companyId: number, key: string) {
    const match = /^(SI|PI|SR|PR|INTERNAL)-(\d+)$/.exec(key) ?? /^PPh-(PI)-(\d+)-\d+$/.exec(key)
    if (!match) throw new ValidationError('Sumber dokumen pajak tidak dikenali')
    const type = match[1]!,
      id = Number(match[2]),
      tables: Record<string, [string, string]> = {
        SI: ['sales_invoices', 'invoice_date'],
        PI: ['purchase_invoices', 'invoice_date'],
        SR: ['sales_returns', 'return_date'],
        PR: ['purchase_returns', 'return_date'],
      }
    const [rows] =
      type === 'INTERNAL'
        ? await connection.execute<RowDataPacket[]>(
            'SELECT p.tax_period period FROM tax_internal_rows r JOIN tax_reconciliation_periods p ON p.id=r.period_id WHERE r.id=? AND r.company_id=?',
            [id, companyId],
          )
        : await connection.execute<RowDataPacket[]>(
            `SELECT ${tables[type]![1]} period FROM ${tables[type]![0]} WHERE id=? AND company_id=?`,
            [id, companyId],
          )
    if (!rows[0])
      throw new NotFoundError('Sumber dokumen pajak tidak ditemukan dalam perusahaan ini')
    return dateOnly(rows[0].period).slice(0, 7)
  }
  async amend(companyId: number, period: string, reason: string, context: PostingContext) {
    return transaction(async (c) => {
      const id = await this.ensurePeriod(c, companyId, period, context.userId)
      const [rows] = await c.execute<RowDataPacket[]>(
        'SELECT * FROM tax_reconciliation_periods WHERE id=? FOR UPDATE',
        [id],
      )
      if (!rows[0]?.imported_at) throw new ConflictError('Belum ada SPT untuk dibetulkan')
      if (rows[0].status !== 'locked')
        throw new ConflictError(
          'Pembetulan dimulai dari masa yang sudah dikunci; masa terbuka dapat diperbaiki melalui impor pengganti',
        )
      const [snapshot] = await c.execute<RowDataPacket[]>(
        'SELECT * FROM tax_report_rows WHERE company_id=? AND period_id=?',
        [companyId, id],
      )
      await c.execute(
        'INSERT INTO tax_report_versions(company_id,period_id,revision,source_file,snapshot,reason,created_by) VALUES(?,?,?,?,?,?,?)',
        [
          companyId,
          id,
          rows[0].revision,
          rows[0].source_file,
          JSON.stringify(snapshot),
          reason,
          context.userId,
        ],
      )
      await c.execute(
        "UPDATE tax_reconciliation_periods SET status='open',revision=revision+1,imported_at=NULL,source_file=NULL,reviewed_by=NULL,reviewed_at=NULL,locked_by=NULL,locked_at=NULL WHERE id=?",
        [id],
      )
      await c.execute('DELETE FROM tax_report_rows WHERE company_id=? AND period_id=?', [
        companyId,
        id,
      ])
      await c.execute(
        'DELETE FROM tax_reconciliation_resolutions WHERE company_id=? AND period_id=?',
        [companyId, id],
      )
      await new AuditService().log(c, {
        companyId,
        userId: context.userId,
        module: 'tax-reconciliation',
        action: 'update',
        recordType: 'tax_reconciliation_period',
        recordId: id,
        oldValue: rows[0],
        newValue: { reason, revision: Number(rows[0].revision) + 1, status: 'open' },
      })
      return { periodId: id, revision: Number(rows[0].revision) + 1 }
    })
  }
  async payment(
    companyId: number,
    input: z.infer<typeof taxPaymentSchema>,
    context: PostingContext,
  ) {
    return transaction(async (c) => {
      const [journals] = await c.execute<RowDataPacket[]>(
        'SELECT id,status,journal_date FROM journals WHERE id=? AND company_id=? FOR UPDATE',
        [input.journal_id, companyId],
      )
      if (journals[0]?.status !== 'posted' || dateOnly(journals[0].journal_date) !== input.date)
        throw new ValidationError(
          'Bukti pembayaran harus terkait jurnal posted dengan tanggal pembayaran yang sama',
        )
      const [accounts] = await c.execute<RowDataPacket[]>(
        `SELECT a.id FROM accounts a WHERE a.company_id=? AND a.id=? AND a.account_type='liability' AND (a.id IN(SELECT output_tax_account_id FROM tax_codes WHERE company_id=? UNION SELECT pph21_payable_account_id FROM payroll_policies WHERE company_id=? UNION SELECT account_id FROM account_mappings WHERE company_id=? AND mapping_key IN('OUTPUT_VAT','WITHHOLDING_TAX')))`,
        [companyId, input.account_id, companyId, companyId, companyId],
      )
      if (!accounts[0])
        throw new ValidationError(
          'Pilih akun utang pajak yang dipetakan di kode pajak, payroll atau default mapping',
        )
      const [groupAccounts] = await c.execute<RowDataPacket[]>(
        `SELECT id FROM accounts WHERE id=? AND id IN (
        SELECT output_tax_account_id FROM tax_codes WHERE company_id=? AND (?='ppn' AND tax_type='vat' OR ?='pph21' AND reporting_type IN('pph21_employee','pph21_non_employee') OR ?='unification' AND tax_type='withholding' AND COALESCE(reporting_type,'pph23') NOT IN('pph21_employee','pph21_non_employee'))
        UNION SELECT pph21_payable_account_id FROM payroll_policies WHERE company_id=? AND ?='pph21'
        UNION SELECT account_id FROM account_mappings WHERE company_id=? AND (mapping_key='OUTPUT_VAT' AND ?='ppn' OR mapping_key='WITHHOLDING_TAX' AND ?='unification'))`,
        [
          input.account_id,
          companyId,
          input.tax_group,
          input.tax_group,
          input.tax_group,
          companyId,
          input.tax_group,
          companyId,
          input.tax_group,
          input.tax_group,
        ],
      )
      if (!groupAccounts.length)
        throw new ValidationError('Akun utang pajak tidak sesuai kelompok setoran yang dipilih')
      const [cash] = await c.execute<RowDataPacket[]>(
        `SELECT COALESCE(SUM(l.credit-l.debit),0) amount FROM journal_lines l WHERE l.journal_id=? AND l.account_id IN(SELECT gl_account_id FROM bank_accounts WHERE company_id=? AND deleted_at IS NULL UNION SELECT account_id FROM account_mappings WHERE company_id=? AND mapping_key IN('CASH','BANK'))`,
        [input.journal_id, companyId, companyId],
      )
      const [cashUsed] = await c.execute<RowDataPacket[]>(
        'SELECT COALESCE(SUM(amount),0) amount FROM tax_payment_evidence WHERE company_id=? AND journal_id=?',
        [companyId, input.journal_id],
      )
      if (
        compareDecimal(addDecimal([String(cashUsed[0]!.amount), input.amount]), cash[0]!.amount) > 0
      )
        throw new ValidationError(
          'Bukti setoran harus didukung kredit kas/bank yang cukup pada jurnal pembayaran',
        )
      const [net] = await c.execute<RowDataPacket[]>(
        'SELECT COALESCE(SUM(debit-credit),0) amount FROM journal_lines WHERE journal_id=? AND account_id=?',
        [input.journal_id, input.account_id],
      )
      const [used] = await c.execute<RowDataPacket[]>(
        'SELECT COALESCE(SUM(amount),0) amount FROM tax_payment_evidence WHERE company_id=? AND journal_id=? AND account_id=?',
        [companyId, input.journal_id, input.account_id],
      )
      if (compareDecimal(addDecimal([String(used[0]!.amount), input.amount]), net[0]!.amount) > 0)
        throw new ConflictError('Alokasi bukti melebihi debit bersih pelunasan pajak pada jurnal')
      const [duplicate] = await c.execute<RowDataPacket[]>(
        'SELECT id FROM tax_payment_evidence WHERE company_id=? AND ntpn=? AND tax_group=? AND account_id=?',
        [companyId, input.ntpn, input.tax_group, input.account_id],
      )
      if (duplicate[0]) throw new ConflictError('Bukti pembayaran yang sama sudah dicatat')
      await c.execute(
        'INSERT INTO tax_payment_evidence(company_id,tax_period,tax_group,payment_date,ntpn,journal_id,account_id,amount,notes,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)',
        [
          companyId,
          input.period,
          input.tax_group,
          input.date,
          input.ntpn,
          input.journal_id,
          input.account_id,
          input.amount,
          input.notes,
          context.userId,
        ],
      )
      await new AuditService().log(c, {
        companyId,
        userId: context.userId,
        module: 'tax-reconciliation',
        action: 'create',
        recordType: 'tax_payment_evidence',
        recordId: input.journal_id,
        newValue: input,
      })
      return { saved: true }
    })
  }
}
