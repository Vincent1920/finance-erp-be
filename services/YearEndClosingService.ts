import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { db, transaction } from '../config/database'
import type { QueryExecutor } from '../types/database'
import { ConflictError, NotFoundError, ValidationError } from '../utils/AppError'
import {
  compareDecimal,
  fromScaledInteger,
  subtractDecimal,
  toScaledInteger,
} from '../utils/decimal'
import { AuditService } from './AuditService'
import { BusinessValidationService } from './BusinessValidationService'
import { PostingService, type JournalLineInput, type PostingContext } from './PostingService'

type YearEndInput = {
  fiscal_year: number
  current_year_earnings_account_id: number
  retained_earnings_account_id: number
  notes?: string | null
}

type ClosingRow = RowDataPacket & {
  id: number
  status: 'draft' | 'validated' | 'posted' | 'reversed'
  fiscal_year: number
  closing_date: Date | string
  current_year_earnings: string | number
  current_year_earnings_account_id: number
  retained_earnings_account_id: number
  closing_journal_id: number | null
  retained_earnings_journal_id: number | null
  created_by: number
}

const dateOnly = (value: Date | string) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)

export function fiscalYearRange(fiscalYear: number, startMonth: number) {
  const month = Math.min(12, Math.max(1, Number(startMonth) || 1))
  if (month === 1) return { dateFrom: `${fiscalYear}-01-01`, dateTo: `${fiscalYear}-12-31` }
  const startYear = fiscalYear - 1
  const endDate = new Date(Date.UTC(fiscalYear, month - 1, 0)).toISOString().slice(0, 10)
  return {
    dateFrom: `${startYear}-${String(month).padStart(2, '0')}-01`,
    dateTo: endDate,
  }
}

export class YearEndClosingService {
  constructor(
    private posting = new PostingService(),
    private validation = new BusinessValidationService(),
    private audit = new AuditService(),
  ) {}

  async overview(companyId: number) {
    const [companyRows] = await db.execute<RowDataPacket[]>(
      'SELECT fiscal_year_start FROM companies WHERE id=?',
      [companyId],
    )
    const [accounts] = await db.execute<RowDataPacket[]>(
      `SELECT id,code,name FROM accounts
       WHERE company_id=? AND account_type='equity' AND is_posting=TRUE
         AND is_active=TRUE AND deleted_at IS NULL ORDER BY code`,
      [companyId],
    )
    const [closings] = await db.execute<RowDataPacket[]>(
      `SELECT y.*,cy.code current_account_code,cy.name current_account_name,
         re.code retained_account_code,re.name retained_account_name,
         cj.journal_number closing_journal_number,rj.journal_number retained_journal_number
       FROM year_end_closings y
       INNER JOIN accounts cy ON cy.id=y.current_year_earnings_account_id
       INNER JOIN accounts re ON re.id=y.retained_earnings_account_id
       LEFT JOIN journals cj ON cj.id=y.closing_journal_id
       LEFT JOIN journals rj ON rj.id=y.retained_earnings_journal_id
       WHERE y.company_id=? ORDER BY y.fiscal_year DESC`,
      [companyId],
    )
    return {
      fiscalYearStart: Number(companyRows[0]?.fiscal_year_start ?? 1),
      accounts,
      closings: closings.map((row) => ({ ...row, closing_date: dateOnly(row.closing_date) })),
    }
  }

  preview(companyId: number, input: YearEndInput) {
    return transaction((connection) => this.buildPreview(connection, companyId, input))
  }

  validate(companyId: number, input: YearEndInput, context: PostingContext) {
    return transaction(async (connection) => {
      const preview = await this.buildPreview(connection, companyId, input)
      const [existing] = await connection.execute<ClosingRow[]>(
        'SELECT * FROM year_end_closings WHERE company_id=? AND fiscal_year=? FOR UPDATE',
        [companyId, input.fiscal_year],
      )
      if (existing[0]?.status === 'posted') throw new ConflictError('Tahun fiskal sudah ditutup')
      if (existing[0]?.status === 'reversed')
        throw new ConflictError(
          'Penutupan tahun yang sudah dibalik tidak dapat diposting ulang. Buat koreksi melalui jurnal pada periode terbuka',
        )

      let id = Number(existing[0]?.id ?? 0)
      if (id) {
        await connection.execute(
          `UPDATE year_end_closings SET closing_date=?,status='validated',
             current_year_earnings=?,current_year_earnings_account_id=?,
             retained_earnings_account_id=?,closing_journal_id=NULL,
             retained_earnings_journal_id=NULL,notes=?,validated_by=?,validated_at=NOW()
           WHERE id=?`,
          [
            preview.range.dateTo,
            preview.netProfit,
            input.current_year_earnings_account_id,
            input.retained_earnings_account_id,
            input.notes ?? null,
            context.userId,
            id,
          ],
        )
        await connection.execute('DELETE FROM year_end_closing_lines WHERE year_end_closing_id=?', [
          id,
        ])
      } else {
        const [created] = await connection.execute<ResultSetHeader>(
          `INSERT INTO year_end_closings(
             company_id,fiscal_year,closing_date,status,current_year_earnings,
             current_year_earnings_account_id,retained_earnings_account_id,notes,
             created_by,validated_by,validated_at
           ) VALUES(?,?,?,'validated',?,?,?,?,?,?,NOW())`,
          [
            companyId,
            input.fiscal_year,
            preview.range.dateTo,
            preview.netProfit,
            input.current_year_earnings_account_id,
            input.retained_earnings_account_id,
            input.notes ?? null,
            context.userId,
            context.userId,
          ],
        )
        id = created.insertId
      }
      for (const line of preview.accountLines)
        await connection.execute(
          `INSERT INTO year_end_closing_lines(
             year_end_closing_id,account_id,closing_balance,debit,credit
           ) VALUES(?,?,?,?,?)`,
          [id, line.accountId, line.closingBalance, line.debit, line.credit],
        )
      await this.audit.log(connection, {
        companyId,
        userId: context.userId,
        module: 'year-end-closing',
        action: 'validate',
        recordType: 'year_end_closing',
        recordId: id,
        newValue: { fiscalYear: input.fiscal_year, netProfit: preview.netProfit },
        requestId: context.requestId,
        ip: context.ip,
      })
      return { id, status: 'validated' as const, ...preview }
    })
  }

  post(companyId: number, id: number, context: PostingContext) {
    return transaction(async (connection) => {
      const closing = await this.closing(connection, companyId, id, true)
      if (closing.status !== 'validated')
        throw new ConflictError('Penutupan tahun harus divalidasi sebelum diposting')
      await this.validation.ensureIndependentApprover(
        connection,
        companyId,
        Number(closing.created_by),
        context.userId,
      )
      const preview = await this.buildPreview(connection, companyId, {
        fiscal_year: Number(closing.fiscal_year),
        current_year_earnings_account_id: Number(closing.current_year_earnings_account_id),
        retained_earnings_account_id: Number(closing.retained_earnings_account_id),
      })
      if (compareDecimal(preview.netProfit, String(closing.current_year_earnings)) !== 0)
        throw new ConflictError('Saldo laba rugi berubah setelah validasi. Jalankan validasi ulang')

      const closingJournalId = await this.posting.createPostedJournal(connection, {
        companyId,
        sourceType: 'year_end_closing',
        sourceId: id,
        date: preview.range.dateTo,
        reference: `YE-${closing.fiscal_year}`,
        description: `Penutupan akun laba rugi tahun fiskal ${closing.fiscal_year}`,
        lines: preview.closingJournalLines,
        context,
      })
      let retainedJournalId: number | null = null
      if (compareDecimal(preview.netProfit, '0') !== 0)
        retainedJournalId = await this.posting.createPostedJournal(connection, {
          companyId,
          sourceType: 'year_end_retained_earnings',
          sourceId: id,
          date: preview.range.dateTo,
          reference: `RE-${closing.fiscal_year}`,
          description: `Pemindahan laba berjalan ke laba ditahan ${closing.fiscal_year}`,
          lines: preview.retainedJournalLines,
          context,
        })
      await connection.execute(
        `UPDATE year_end_closings SET status='posted',closing_journal_id=?,
           retained_earnings_journal_id=?,posted_by=?,posted_at=NOW() WHERE id=?`,
        [closingJournalId, retainedJournalId, context.userId, id],
      )
      await this.audit.log(connection, {
        companyId,
        userId: context.userId,
        module: 'year-end-closing',
        action: 'post',
        recordType: 'year_end_closing',
        recordId: id,
        newValue: { closingJournalId, retainedJournalId, netProfit: preview.netProfit },
        requestId: context.requestId,
        ip: context.ip,
      })
      return { id, status: 'posted' as const, closingJournalId, retainedJournalId }
    })
  }

  reverse(
    companyId: number,
    id: number,
    reversalDate: string,
    reason: string,
    context: PostingContext,
  ) {
    return transaction(async (connection) => {
      const closing = await this.closing(connection, companyId, id, true)
      if (closing.status !== 'posted')
        throw new ConflictError('Hanya penutupan tahun yang sudah diposting dapat dibalik')
      if (reversalDate !== dateOnly(closing.closing_date))
        throw new ValidationError(
          'Pembalikan tutup tahun harus memakai tanggal penutupan agar saldo tahun berikutnya tidak berubah',
        )
      let retainedReversalId: number | null = null
      if (closing.retained_earnings_journal_id)
        retainedReversalId = await this.posting.reversePostedJournal(connection, {
          companyId,
          journalId: Number(closing.retained_earnings_journal_id),
          date: reversalDate,
          reason,
          context,
          sourceType: 'year_end_retained_reversal',
          sourceId: id,
        })
      const reversalId = await this.posting.reversePostedJournal(connection, {
        companyId,
        journalId: Number(closing.closing_journal_id),
        date: reversalDate,
        reason,
        context,
        sourceType: 'year_end_closing_reversal',
        sourceId: id,
      })
      await connection.execute(
        `UPDATE year_end_closings SET status='reversed',reversal_journal_id=?,
           reversed_by=?,reversed_at=NOW() WHERE id=?`,
        [reversalId, context.userId, id],
      )
      await this.audit.log(connection, {
        companyId,
        userId: context.userId,
        module: 'year-end-closing',
        action: 'reverse',
        recordType: 'year_end_closing',
        recordId: id,
        oldValue: { status: 'posted' },
        newValue: { status: 'reversed', reversalId, retainedReversalId, reason },
        requestId: context.requestId,
        ip: context.ip,
      })
      return { id, status: 'reversed' as const, reversalId, retainedReversalId }
    })
  }

  private async buildPreview(connection: QueryExecutor, companyId: number, input: YearEndInput) {
    const [companies] = await connection.execute<RowDataPacket[]>(
      'SELECT fiscal_year_start FROM companies WHERE id=?',
      [companyId],
    )
    if (!companies[0]) throw new NotFoundError('Perusahaan tidak ditemukan')
    const range = fiscalYearRange(input.fiscal_year, Number(companies[0].fiscal_year_start ?? 1))
    await this.validateAccounts(connection, companyId, input)
    const [periods] = await connection.execute<RowDataPacket[]>(
      `SELECT id,start_date,end_date,status FROM accounting_periods
       WHERE company_id=? AND start_date>=? AND end_date<=? ORDER BY start_date FOR SHARE`,
      [companyId, range.dateFrom, range.dateTo],
    )
    if (
      periods.length !== 12 ||
      dateOnly(periods[0]?.start_date as Date | string) !== range.dateFrom ||
      dateOnly(periods.at(-1)?.end_date as Date | string) !== range.dateTo
    )
      throw new ConflictError('Tahun fiskal harus memiliki 12 periode bulanan yang lengkap')
    const openPeriods = periods.filter((period) => period.status !== 'closed')
    if (openPeriods.length)
      throw new ConflictError(
        `${openPeriods.length} periode dalam tahun fiskal belum ditutup permanen`,
      )

    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT a.id,a.code,a.name,a.account_type,
         COALESCE(SUM(CASE WHEN j.id IS NOT NULL THEN jl.debit ELSE 0 END),0) debit,
         COALESCE(SUM(CASE WHEN j.id IS NOT NULL THEN jl.credit ELSE 0 END),0) credit
       FROM accounts a
       LEFT JOIN journal_lines jl ON jl.account_id=a.id
       LEFT JOIN journals j ON j.id=jl.journal_id AND j.company_id=a.company_id
         AND j.status IN('posted','reversed') AND j.journal_date BETWEEN ? AND ?
       WHERE a.company_id=? AND a.deleted_at IS NULL AND a.is_posting=TRUE
         AND a.account_type IN('revenue','other_income','cogs','expense','other_expense')
       GROUP BY a.id,a.code,a.name,a.account_type ORDER BY a.code`,
      [range.dateFrom, range.dateTo, companyId],
    )
    const accountLines = rows
      .map((row) => {
        const balance = subtractDecimal(String(row.debit), String(row.credit))
        const minor = toScaledInteger(balance)
        return {
          accountId: Number(row.id),
          code: String(row.code),
          name: String(row.name),
          accountType: String(row.account_type),
          closingBalance: balance,
          debit: minor < 0n ? fromScaledInteger(-minor) : '0.00',
          credit: minor > 0n ? fromScaledInteger(minor) : '0.00',
        }
      })
      .filter((line) => compareDecimal(line.closingBalance, '0') !== 0)
    const netProfitMinor = accountLines.reduce(
      (total, line) => total - toScaledInteger(line.closingBalance),
      0n,
    )
    const netProfit = fromScaledInteger(netProfitMinor)
    if (!accountLines.length)
      throw new ConflictError('Tidak ada saldo akun laba rugi yang dapat ditutup')

    const closingJournalLines: JournalLineInput[] = accountLines.map((line) => ({
      accountId: line.accountId,
      description: `Tutup tahun ${input.fiscal_year}`,
      debit: line.debit,
      credit: line.credit,
    }))
    if (netProfitMinor !== 0n)
      closingJournalLines.push({
        accountId: input.current_year_earnings_account_id,
        description: `Laba/rugi berjalan ${input.fiscal_year}`,
        debit: netProfitMinor < 0n ? fromScaledInteger(-netProfitMinor) : '0.00',
        credit: netProfitMinor > 0n ? netProfit : '0.00',
      })
    const retainedJournalLines: JournalLineInput[] =
      netProfitMinor === 0n
        ? []
        : netProfitMinor > 0n
          ? [
              {
                accountId: input.current_year_earnings_account_id,
                debit: netProfit,
                credit: '0.00',
              },
              { accountId: input.retained_earnings_account_id, debit: '0.00', credit: netProfit },
            ]
          : [
              {
                accountId: input.retained_earnings_account_id,
                debit: fromScaledInteger(-netProfitMinor),
                credit: '0.00',
              },
              {
                accountId: input.current_year_earnings_account_id,
                debit: '0.00',
                credit: fromScaledInteger(-netProfitMinor),
              },
            ]
    return { range, netProfit, accountLines, closingJournalLines, retainedJournalLines }
  }

  private async validateAccounts(
    connection: QueryExecutor,
    companyId: number,
    input: YearEndInput,
  ) {
    const ids = [input.current_year_earnings_account_id, input.retained_earnings_account_id]
    if (ids[0] === ids[1])
      throw new ValidationError('Akun laba berjalan dan laba ditahan harus berbeda')
    const [accounts] = await connection.execute<RowDataPacket[]>(
      `SELECT id FROM accounts WHERE company_id=? AND id IN (?,?) AND account_type='equity'
         AND is_posting=TRUE AND is_active=TRUE AND deleted_at IS NULL`,
      [companyId, ...ids],
    )
    if (accounts.length !== 2)
      throw new ValidationError('Pilih dua akun ekuitas aktif yang dapat menerima posting')
  }

  private async closing(connection: QueryExecutor, companyId: number, id: number, lock = false) {
    const [rows] = await connection.execute<ClosingRow[]>(
      `SELECT * FROM year_end_closings WHERE id=? AND company_id=? ${lock ? 'FOR UPDATE' : ''}`,
      [id, companyId],
    )
    if (!rows[0]) throw new NotFoundError('Penutupan tahun tidak ditemukan')
    return rows[0]
  }
}
