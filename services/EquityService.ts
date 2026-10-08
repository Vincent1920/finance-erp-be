import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { z } from 'zod'
import { db, transaction } from '../config/database'
import type { QueryExecutor } from '../types/database'
import { ConflictError, NotFoundError, ValidationError } from '../utils/AppError'
import { addDecimal, compareDecimal, subtractDecimal } from '../utils/decimal'
import type {
  equityTransactionSchema,
  holdingCreateSchema,
  shareholderSchema,
  shareholderUpdateSchema,
} from '../validators/equity.validator'
import { AccountMappingService } from './AccountMappingService'
import { AuditService } from './AuditService'
import { idempotentOperation } from './IdempotentOperation'
import { JournalService } from './JournalService'
import { NumberSequenceService } from './NumberSequenceService'
import type { PostingContext } from './PostingService'
import { ReportingService } from './ReportingService'

const dateOnly = (value: unknown) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)
export function previousDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

export function equityMovement(opening: string, closing: string) {
  const movement = subtractDecimal(closing, opening)
  return {
    opening,
    increase: compareDecimal(movement, '0') >= 0 ? movement : '0.00',
    decrease: compareDecimal(movement, '0') < 0 ? subtractDecimal('0', movement) : '0.00',
    closing,
  }
}

export class EquityService {
  constructor(
    private mappings = new AccountMappingService(),
    private journals = new JournalService(),
    private sequences = new NumberSequenceService(),
    private audit = new AuditService(),
    private reporting = new ReportingService(),
  ) {}

  private log(
    connection: QueryExecutor,
    companyId: number,
    context: PostingContext,
    action: string,
    recordType: string,
    recordId: number,
    newValue: unknown,
    oldValue?: unknown,
  ) {
    return this.audit.log(connection, {
      companyId,
      userId: context.userId,
      module: 'accounting',
      action,
      recordType,
      recordId,
      newValue,
      oldValue,
      requestId: context.requestId,
      ip: context.ip,
    })
  }

  async shareholders(companyId: number, asOfDate: string) {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT s.*,h.shares,h.nominal_value,h.effective_date,
        COALESCE(h.shares*h.nominal_value,0) nominal_capital
       FROM shareholders s LEFT JOIN shareholder_holdings h ON h.shareholder_id=s.id AND h.effective_date=(
         SELECT MAX(h2.effective_date) FROM shareholder_holdings h2 WHERE h2.shareholder_id=s.id AND h2.effective_date<=?)
       WHERE s.company_id=? ORDER BY s.name,s.id`,
      [asOfDate, companyId],
    )
    // Inactive shareholders still own shares until a dated holding change records the transfer.
    const totalShares = rows.reduce((sum, row) => sum + Number(row.shares ?? 0), 0)
    return rows.map((row) => ({
      ...row,
      id: Number(row.id),
      nominal_capital: String(row.nominal_capital ?? '0'),
      shares: Number(row.shares ?? 0),
      effective_date: row.effective_date ? dateOnly(row.effective_date) : null,
      ownership_percentage: totalShares ? (Number(row.shares ?? 0) * 100) / totalShares : 0,
    }))
  }

  async history(companyId: number, id: number) {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT h.*,u.name created_by_name FROM shareholder_holdings h
       JOIN shareholders s ON s.id=h.shareholder_id JOIN users u ON u.id=h.created_by
       WHERE s.company_id=? AND s.id=? ORDER BY h.effective_date DESC`,
      [companyId, id],
    )
    return rows.map((row) => ({ ...row, effective_date: dateOnly(row.effective_date) }))
  }

  createShareholder(
    companyId: number,
    input: z.infer<typeof shareholderSchema>,
    context: PostingContext,
  ) {
    return transaction(async (connection) => {
      const [existing] = await connection.execute<RowDataPacket[]>(
        'SELECT id FROM shareholders WHERE company_id=? AND code=?',
        [companyId, input.code],
      )
      if (existing.length) throw new ConflictError('Kode pemegang saham sudah digunakan')
      const [result] = await connection.execute<ResultSetHeader>(
        'INSERT INTO shareholders(company_id,code,name,email,notes,created_by) VALUES(?,?,?,?,?,?)',
        [
          companyId,
          input.code,
          input.name,
          input.email || null,
          input.notes || null,
          context.userId,
        ],
      )
      const h = input.holding
      await connection.execute(
        `INSERT INTO shareholder_holdings(shareholder_id,effective_date,shares,nominal_value,reason,created_by)
        VALUES(?,?,?,?,?,?)`,
        [result.insertId, h.effective_date, h.shares, h.nominal_value, h.reason, context.userId],
      )
      await this.log(
        connection,
        companyId,
        context,
        'create',
        'shareholder',
        result.insertId,
        input,
      )
      return { id: result.insertId }
    })
  }

  private async lockedShareholder(
    connection: QueryExecutor,
    companyId: number,
    id: number,
    version?: number,
  ) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT * FROM shareholders WHERE company_id=? AND id=? FOR UPDATE',
      [companyId, id],
    )
    if (!rows[0]) throw new NotFoundError('Pemegang saham tidak ditemukan')
    if (version !== undefined && Number(rows[0].version) !== version)
      throw new ConflictError('Data pemegang saham berubah. Muat ulang sebelum menyimpan.')
    return rows[0]
  }

  updateShareholder(
    companyId: number,
    id: number,
    input: z.infer<typeof shareholderUpdateSchema>,
    context: PostingContext,
  ) {
    return transaction(async (connection) => {
      const old = await this.lockedShareholder(connection, companyId, id, input.version)
      await connection.execute(
        `UPDATE shareholders SET name=?,email=?,notes=?,is_active=?,version=version+1 WHERE id=?`,
        [input.name, input.email || null, input.notes || null, input.is_active, id],
      )
      await this.log(connection, companyId, context, 'update', 'shareholder', id, input, old)
      return { id }
    })
  }

  addHolding(
    companyId: number,
    id: number,
    input: z.infer<typeof holdingCreateSchema>,
    context: PostingContext,
  ) {
    return transaction(async (connection) => {
      await this.lockedShareholder(connection, companyId, id, input.version)
      const [existing] = await connection.execute<RowDataPacket[]>(
        'SELECT id FROM shareholder_holdings WHERE shareholder_id=? AND effective_date=?',
        [id, input.effective_date],
      )
      if (existing.length)
        throw new ConflictError(
          'Sudah ada riwayat pada tanggal ini. Gunakan tanggal efektif perubahan yang berbeda.',
        )
      await connection.execute(
        `INSERT INTO shareholder_holdings(shareholder_id,effective_date,shares,nominal_value,reason,created_by)
        VALUES(?,?,?,?,?,?)`,
        [id, input.effective_date, input.shares, input.nominal_value, input.reason, context.userId],
      )
      await connection.execute('UPDATE shareholders SET version=version+1 WHERE id=?', [id])
      await this.log(connection, companyId, context, 'change_holding', 'shareholder', id, input)
      return { id }
    })
  }

  async transactions(companyId: number, dateFrom: string, dateTo: string) {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT t.*,s.name shareholder_name,s.code shareholder_code,a.code equity_account_code,a.name equity_account_name,
       b.code counterpart_account_code,b.name counterpart_account_name,j.journal_number,j.status journal_status,
       CASE WHEN t.cancelled_at IS NOT NULL THEN 'cancelled' ELSE j.status END status
       FROM equity_transactions t JOIN shareholders s ON s.id=t.shareholder_id JOIN accounts a ON a.id=t.equity_account_id
       LEFT JOIN accounts b ON b.id=t.counterpart_account_id LEFT JOIN journals j ON j.id=t.journal_id
       WHERE t.company_id=? AND t.transaction_date BETWEEN ? AND ? ORDER BY t.transaction_date DESC,t.id DESC`,
      [companyId, dateFrom, dateTo],
    )
    return rows.map((row) => ({ ...row, transaction_date: dateOnly(row.transaction_date) }))
  }

  async journalOptions(companyId: number) {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT j.id,j.journal_number,j.journal_date,a.id account_id,a.code account_code,a.name account_name,
       SUM(jl.credit-jl.debit) amount,
       COALESCE((SELECT SUM(t.amount) FROM equity_transactions t WHERE t.company_id=j.company_id AND t.journal_id=j.id
         AND t.equity_account_id=a.id AND t.transaction_type='opening_detail' AND t.cancelled_at IS NULL),0) allocated
       FROM journals j JOIN journal_lines jl ON jl.journal_id=j.id JOIN accounts a ON a.id=jl.account_id
       WHERE j.company_id=? AND j.status='posted' AND a.account_type='equity'
         AND NOT EXISTS(SELECT 1 FROM equity_transactions t WHERE t.journal_id=j.id AND t.transaction_type<>'opening_detail')
       GROUP BY j.id,j.journal_number,j.journal_date,a.id,a.code,a.name
       HAVING amount>allocated ORDER BY j.journal_date DESC,j.id DESC`,
      [companyId],
    )
    return rows.map((row) => ({
      ...row,
      journal_date: dateOnly(row.journal_date),
      available: subtractDecimal(String(row.amount), String(row.allocated)),
    }))
  }

  createTransaction(
    companyId: number,
    input: z.infer<typeof equityTransactionSchema>,
    context: PostingContext,
  ) {
    return idempotentOperation(
      companyId,
      input.request_key,
      'equity-create',
      input,
      async (connection) => {
        const shareholder = await this.lockedShareholder(
          connection,
          companyId,
          input.shareholder_id,
        )
        if (!shareholder.is_active)
          throw new ValidationError('Pemegang saham nonaktif tidak dapat menerima transaksi baru')
        const equityId = await this.mappings.resolve(
          connection,
          companyId,
          input.transaction_type === 'dividend' ? 'RETAINED_EARNINGS' : 'PAID_IN_CAPITAL',
          input.equity_account_id,
        )
        const [companies] = await connection.execute<RowDataPacket[]>(
          'SELECT base_currency FROM companies WHERE id=?',
          [companyId],
        )
        const currency = String(companies[0]!.base_currency)
        let counterpartId = input.counterpart_account_id ?? null
        let journalId = input.journal_id ?? null
        if (input.transaction_type === 'opening_detail') {
          const [journals] = await connection.execute<RowDataPacket[]>(
            'SELECT id,journal_date,status FROM journals WHERE company_id=? AND id=? FOR UPDATE',
            [companyId, journalId],
          )
          if (!journals[0] || journals[0].status !== 'posted')
            throw new ValidationError('Jurnal modal harus sudah diposting')
          if (dateOnly(journals[0].journal_date) !== input.transaction_date)
            throw new ValidationError('Tanggal rincian modal harus sama dengan tanggal jurnal asal')
          const [sources] = await connection.execute<RowDataPacket[]>(
            "SELECT id FROM equity_transactions WHERE journal_id=? AND transaction_type<>'opening_detail'",
            [journalId],
          )
          if (sources.length)
            throw new ValidationError('Jurnal ini sudah tercatat sebagai transaksi modal')
          const [amounts] = await connection.execute<RowDataPacket[]>(
            `SELECT COALESCE(SUM(credit-debit),0) amount FROM journal_lines WHERE journal_id=? AND account_id=?`,
            [journalId, equityId],
          )
          const [allocations] = await connection.execute<RowDataPacket[]>(
            `SELECT COALESCE(SUM(amount),0) amount FROM equity_transactions
           WHERE journal_id=? AND equity_account_id=? AND transaction_type='opening_detail' AND cancelled_at IS NULL`,
            [journalId, equityId],
          )
          const remaining = subtractDecimal(
            String(amounts[0]!.amount),
            String(allocations[0]!.amount),
          )
          if (compareDecimal(input.amount, remaining) > 0)
            throw new ValidationError(
              `Rincian melebihi sisa modal jurnal yang belum dialokasikan (${remaining})`,
            )
          counterpartId = null
        } else if (input.transaction_type === 'dividend') {
          counterpartId = await this.mappings.resolve(
            connection,
            companyId,
            'DIVIDENDS_PAYABLE',
            counterpartId,
          )
        } else {
          const [accounts] = await connection.execute<RowDataPacket[]>(
            "SELECT id FROM accounts WHERE company_id=? AND id=? AND account_type='asset' AND is_active=TRUE AND is_posting=TRUE AND deleted_at IS NULL",
            [companyId, counterpartId],
          )
          if (!accounts.length)
            throw new ValidationError(
              'Akun penerima modal harus akun aset aktif yang dapat diposting',
            )
          // Foreign bank deposits must first be converted to the company's functional currency.
          const [foreignBanks] = await connection.execute<RowDataPacket[]>(
            'SELECT id FROM bank_accounts WHERE company_id=? AND gl_account_id=? AND currency<>? AND deleted_at IS NULL',
            [companyId, counterpartId, currency],
          )
          if (foreignBanks.length)
            throw new ValidationError(
              'Setoran rekening valuta asing perlu jurnal dengan kurs; gunakan rincian modal dari jurnal yang sudah diposting',
            )
        }
        const number = await this.sequences.next(
          connection,
          companyId,
          'equity_transaction',
          input.transaction_date,
        )
        const [result] = await connection.execute<ResultSetHeader>(
          `INSERT INTO equity_transactions(company_id,transaction_number,shareholder_id,transaction_date,transaction_type,amount,currency,
         equity_account_id,counterpart_account_id,journal_id,reference,notes,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            companyId,
            number,
            input.shareholder_id,
            input.transaction_date,
            input.transaction_type,
            input.amount,
            currency,
            equityId,
            counterpartId,
            journalId,
            input.reference || null,
            input.notes || null,
            context.userId,
          ],
        )
        if (input.transaction_type !== 'opening_detail') {
          const isDividend = input.transaction_type === 'dividend'
          const journal = await this.journals.createInTransaction(
            connection,
            companyId,
            {
              journal_date: input.transaction_date,
              currency,
              exchange_rate: '1',
              reference: input.reference || number,
              description: `${isDividend ? 'Penetapan dividen' : 'Setoran modal'} ${shareholder.name} · ${number}`,
              lines: [
                {
                  accountId: isDividend ? equityId : counterpartId!,
                  debit: input.amount,
                  credit: '0',
                  description: input.notes?.slice(0, 255),
                },
                {
                  accountId: isDividend ? counterpartId! : equityId,
                  debit: '0',
                  credit: input.amount,
                  description: input.notes?.slice(0, 255),
                },
              ],
            },
            context,
          )
          journalId = journal.id
          await connection.execute(
            "UPDATE journals SET source_type='equity_transaction',source_id=? WHERE id=?",
            [result.insertId, journalId],
          )
          await connection.execute('UPDATE equity_transactions SET journal_id=? WHERE id=?', [
            journalId,
            result.insertId,
          ])
        }
        await this.log(
          connection,
          companyId,
          context,
          'create',
          'equity_transaction',
          result.insertId,
          { ...input, number, journalId },
        )
        return { id: result.insertId, transactionNumber: number, journalId }
      },
    )
  }

  async cancel(companyId: number, id: number, reason: string, context: PostingContext) {
    return transaction(async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT * FROM equity_transactions WHERE company_id=? AND id=? FOR UPDATE',
        [companyId, id],
      )
      const item = rows[0]
      if (!item) throw new NotFoundError('Transaksi modal tidak ditemukan')
      if (item.cancelled_at) throw new ConflictError('Transaksi sudah dibatalkan')
      if (item.transaction_type !== 'opening_detail') {
        const [journals] = await connection.execute<RowDataPacket[]>(
          'SELECT status FROM journals WHERE id=? FOR UPDATE',
          [item.journal_id],
        )
        if (!['draft', 'rejected'].includes(String(journals[0]?.status)))
          throw new ConflictError(
            'Hanya draft atau jurnal ditolak yang dapat dibatalkan. Gunakan pembalikan untuk jurnal posted.',
          )
        await connection.execute(
          "UPDATE journals SET status='cancelled',version=version+1 WHERE id=?",
          [item.journal_id],
        )
      }
      await connection.execute('UPDATE equity_transactions SET cancelled_at=NOW() WHERE id=?', [id])
      await this.log(
        connection,
        companyId,
        context,
        'cancel',
        'equity_transaction',
        id,
        { reason },
        item,
      )
      return { id }
    })
  }

  async report(companyId: number, dateFrom: string, dateTo: string) {
    const [opening, closing, profitLoss, shareholders, mappings] = await Promise.all([
      this.reporting.balanceSheet(companyId, previousDate(dateFrom)),
      this.reporting.balanceSheet(companyId, dateTo),
      this.reporting.profitLoss(companyId, { dateFrom, dateTo }),
      this.shareholders(companyId, dateTo),
      this.mappings.list(companyId),
    ])
    const openingById = new Map(opening.sections.equity.accounts.map((row) => [row.accountId, row]))
    const [periodRows] = await db.execute<RowDataPacket[]>(
      `SELECT jl.account_id,COALESCE(SUM(jl.credit),0) increase_amount,COALESCE(SUM(jl.debit),0) decrease_amount
       FROM journals j JOIN journal_lines jl ON jl.journal_id=j.id JOIN accounts a ON a.id=jl.account_id
       WHERE j.company_id=? AND j.status IN ('posted','reversed') AND j.journal_date BETWEEN ? AND ?
         AND a.account_type='equity' GROUP BY jl.account_id`,
      [companyId, dateFrom, dateTo],
    )
    const periodById = new Map(periodRows.map((row) => [Number(row.account_id), row]))
    const components = closing.sections.equity.accounts.map((row) => ({
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      ...equityMovement(openingById.get(row.accountId)?.amount ?? '0', row.amount),
      increase: String(periodById.get(row.accountId)?.increase_amount ?? '0'),
      decrease: String(periodById.get(row.accountId)?.decrease_amount ?? '0'),
    }))
    const earningsOpening = addDecimal([
      opening.sections.equity.unclosedPriorEarnings,
      opening.sections.equity.currentYearEarnings,
    ])
    const earningsClosing = addDecimal([
      closing.sections.equity.unclosedPriorEarnings,
      closing.sections.equity.currentYearEarnings,
    ])
    const unclosedMovement = equityMovement(earningsOpening, earningsClosing)
    components.push({
      accountId: 0,
      code: '—',
      name: 'Laba/rugi yang belum dipindahkan ke akun ekuitas',
      ...unclosedMovement,
    })
    const sum = (field: 'opening' | 'increase' | 'decrease' | 'closing') =>
      addDecimal(components.map((row) => row[field]))
    const totals = {
      opening: sum('opening'),
      increase: sum('increase'),
      decrease: sum('decrease'),
      closing: sum('closing'),
    }
    const difference = subtractDecimal(totals.closing, closing.equity)
    const [movements] = await db.execute<RowDataPacket[]>(
      `SELECT j.journal_date,j.journal_number,j.source_type,j.description,a.code account_code,a.name account_name,
         SUM(jl.credit-jl.debit) change_amount FROM journals j JOIN journal_lines jl ON jl.journal_id=j.id
       JOIN accounts a ON a.id=jl.account_id WHERE j.company_id=? AND j.status IN ('posted','reversed')
         AND j.journal_date BETWEEN ? AND ? AND a.account_type='equity'
       GROUP BY j.id,j.journal_date,j.journal_number,j.source_type,j.description,a.id,a.code,a.name
       ORDER BY j.journal_date,j.id,a.code`,
      [companyId, dateFrom, dateTo],
    )
    const capitalMapping = mappings.find((row) => row.mapping_key === 'PAID_IN_CAPITAL')
    const capitalAccountId = Number(
      (capitalMapping as Record<string, unknown> | undefined)?.account_id,
    )
    const capitalBalance =
      closing.sections.equity.accounts.find((row) => row.accountId === capitalAccountId)?.amount ??
      '0.00'
    const nominalCapital = addDecimal(shareholders.map((row) => String(row.nominal_capital)))
    const capitalDifference = subtractDecimal(capitalBalance, nominalCapital)
    const [allocations] = await db.execute<RowDataPacket[]>(
      `SELECT t.shareholder_id,COALESCE(SUM(t.amount),0) amount FROM equity_transactions t
       JOIN journals j ON j.id=t.journal_id LEFT JOIN journals r ON r.id=j.reversal_journal_id
       WHERE t.company_id=? AND t.equity_account_id=? AND t.transaction_type IN ('contribution','opening_detail')
         AND t.cancelled_at IS NULL AND j.status IN ('posted','reversed') AND j.journal_date<=?
         AND (r.id IS NULL OR r.journal_date>?) GROUP BY t.shareholder_id`,
      [companyId, capitalAccountId || 0, dateTo, dateTo],
    )
    const allocatedCapital = addDecimal(allocations.map((row) => String(row.amount)))
    const allocatedByHolder = new Map(
      allocations.map((row) => [Number(row.shareholder_id), String(row.amount)]),
    )
    const [companies] = await db.execute<RowDataPacket[]>(
      'SELECT base_currency FROM companies WHERE id=?',
      [companyId],
    )
    return {
      dateFrom,
      dateTo,
      currency: String(companies[0]!.base_currency),
      components,
      totals,
      difference,
      reconciled: compareDecimal(difference, '0') === 0,
      balanceSheetEquity: closing.equity,
      netProfit: profitLoss.netProfit,
      earningsTransfersAndAdjustments: subtractDecimal(
        subtractDecimal(earningsClosing, earningsOpening),
        profitLoss.netProfit,
      ),
      movements: movements.map((row) => ({ ...row, journal_date: dateOnly(row.journal_date) })),
      shareholders: shareholders.map((row) => ({
        ...row,
        recorded_capital: allocatedByHolder.get(Number(row.id)) ?? '0.00',
      })),
      capitalControl: {
        configured: Boolean(capitalMapping?.configured),
        capitalBalance,
        nominalCapital,
        difference: capitalDifference,
        reconciled:
          Boolean(capitalMapping?.configured) && compareDecimal(capitalDifference, '0') === 0,
        allocatedCapital,
        allocationDifference: subtractDecimal(capitalBalance, allocatedCapital),
      },
    }
  }
}
