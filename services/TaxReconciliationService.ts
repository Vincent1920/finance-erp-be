import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { db, transaction } from '../config/database'
import { AuditService } from './AuditService'
import type { PostingContext } from './PostingService'
import { ConflictError, NotFoundError } from '../utils/AppError'
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
        -SUM(l.base_subtotal) dpp,-SUM(l.tax_amount) tax_amount,'Retur penjualan' description
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
        -SUM(l.base_subtotal) dpp,-SUM(l.tax_amount) tax_amount,'Retur pembelian' description
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
       WHERE j.company_id=? AND j.status='posted' AND j.journal_date>=? AND j.journal_date<?`,
      [companyId, start, end],
    )
    const [taxAccounts] = await db.execute<RowDataPacket[]>(
      `SELECT a.code,a.name,SUM(jl.debit-jl.credit) balance
       FROM journals j JOIN journal_lines jl ON jl.journal_id=j.id JOIN accounts a ON a.id=jl.account_id
       WHERE j.company_id=? AND j.status='posted' AND j.journal_date>=? AND j.journal_date<?
         AND a.id IN (SELECT input_tax_account_id FROM tax_codes WHERE company_id=? AND input_tax_account_id IS NOT NULL
                      UNION SELECT output_tax_account_id FROM tax_codes WHERE company_id=? AND output_tax_account_id IS NOT NULL)
       GROUP BY a.id,a.code,a.name ORDER BY a.code`,
      [companyId, start, end, companyId, companyId],
    )
    return {
      revenue: number(rows[0]?.revenue),
      expense: number(rows[0]?.expense),
      taxAccounts: taxAccounts.map((row) => ({
        code: String(row.code),
        name: String(row.name),
        balance: number(row.balance),
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
      },
      totals,
      groups,
      equalizations,
      tax_accounts: book.taxAccounts,
      imported_rows: reported.map((row) => ({ ...row, tax_group: taxGroup(row.tax_type) })),
      rows: comparisons,
    }
  }

  async importReport(companyId: number, input: TaxReportImportInput, context: PostingContext) {
    return transaction(async (connection) => {
      const periodId = await this.ensurePeriod(connection, companyId, input.period, context.userId)
      const [periodRows] = await connection.execute<RowDataPacket[]>(
        'SELECT status FROM tax_reconciliation_periods WHERE id=? AND company_id=? FOR UPDATE',
        [periodId, companyId],
      )
      if (periodRows[0]?.status === 'locked') throw new ConflictError('Masa pajak sudah dikunci')
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
        'SELECT status FROM tax_reconciliation_periods WHERE id=? AND company_id=? FOR UPDATE',
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
    await db.execute(
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
    return { sourceKey: input.source_key, taxDocumentNumber: input.tax_document_number }
  }

  async resolve(companyId: number, input: TaxResolutionInput, context: PostingContext) {
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
    return transaction(async (connection) => {
      const periodId = await this.ensurePeriod(connection, companyId, period, context.userId)
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT status FROM tax_reconciliation_periods WHERE id=? AND company_id=? FOR UPDATE',
        [periodId, companyId],
      )
      if (!rows[0]) throw new NotFoundError('Masa rekonsiliasi tidak ditemukan')
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
}
