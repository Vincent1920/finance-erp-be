import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import type { z } from 'zod'
import { db } from '../config/database'
import { idempotentOperation } from './IdempotentOperation'
import { BankStatementService } from './BankStatementService'
import { AuditService } from './AuditService'
import type { PostingContext } from './PostingService'
import { ConflictError, NotFoundError, ValidationError } from '../utils/AppError'
import { compareDecimal, subtractDecimal } from '../utils/decimal'
import type {
  bankingQuerySchema,
  statementSchema,
  bankMatchSchema,
  bankUnmatchSchema,
} from '../validators/operations.validator'
type Filter = z.output<typeof bankingQuerySchema>
export class BankingService {
  async cash(companyId: number, filter: Filter) {
    let account = filter.account_id
    if (filter.bank_account_id) {
      const [b] = await db.execute<RowDataPacket[]>(
        'SELECT gl_account_id FROM bank_accounts WHERE id=? AND company_id=? AND deleted_at IS NULL',
        [filter.bank_account_id, companyId],
      )
      if (!b[0]) throw new NotFoundError('Rekening tidak ditemukan')
      account = Number(b[0].gl_account_id)
    }
    if (!account) throw new ValidationError('Pilih rekening atau akun kas')
    const [summary] = await db.execute<RowDataPacket[]>(
      `SELECT COALESCE(SUM(CASE WHEN j.journal_date<? THEN l.debit-l.credit ELSE 0 END),0) opening,COALESCE(SUM(CASE WHEN j.journal_date>=? THEN l.debit ELSE 0 END),0) inflow,COALESCE(SUM(CASE WHEN j.journal_date>=? THEN l.credit ELSE 0 END),0) outflow,COALESCE(SUM(l.debit-l.credit),0) closing FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.company_id=? AND j.status IN ('posted','reversed') AND l.account_id=? AND j.journal_date<=?`,
      [filter.date_from, filter.date_from, filter.date_from, companyId, account, filter.date_to],
    )
    const [rows] = await db.execute<RowDataPacket[]>(
      `WITH ledger AS(SELECT l.id,j.id journal_id,j.journal_date date,j.journal_number number,j.reference,l.description,l.debit,l.credit,SUM(l.debit-l.credit) OVER(ORDER BY j.journal_date,j.id,l.id) balance FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.company_id=? AND j.status IN ('posted','reversed') AND l.account_id=? AND j.journal_date<=?) SELECT ledger.*,COALESCE((SELECT SUM(m.matched_amount) FROM bank_reconciliation_matches m WHERE m.journal_line_id=ledger.id AND m.status='confirmed'),0) matched_amount FROM ledger WHERE date>=? ORDER BY date,journal_id,id`,
      [companyId, account, filter.date_to, filter.date_from],
    )
    return { rows, summary: summary[0] }
  }
  async statements(companyId: number, filter: Filter) {
    if (!filter.bank_account_id) throw new ValidationError('Pilih rekening bank')
    const [rows] = await db.execute<RowDataPacket[]>(
      `WITH statement_rows AS(SELECT l.*,s.statement_number,s.opening_balance,s.closing_balance,s.bank_account_id,l.balance-COALESCE(LAG(l.balance) OVER(PARTITION BY s.id ORDER BY l.line_number),s.opening_balance) movement FROM bank_statement_lines l JOIN bank_statements s ON s.id=l.bank_statement_id WHERE s.company_id=? AND s.bank_account_id=?) SELECT * FROM statement_rows WHERE transaction_date BETWEEN ? AND ? ORDER BY transaction_date,bank_statement_id,line_number`,
      [companyId, filter.bank_account_id, filter.date_from, filter.date_to],
    )
    return rows
  }
  async suggestions(companyId: number, filter: Filter) {
    if (!filter.bank_account_id) throw new ValidationError('Pilih rekening bank')
    const [banks] = await db.execute<RowDataPacket[]>('SELECT gl_account_id FROM bank_accounts WHERE id=? AND company_id=? AND is_active=TRUE AND deleted_at IS NULL', [filter.bank_account_id, companyId])
    if (!banks[0]) throw new NotFoundError('Rekening bank tidak ditemukan')
    const [rows] = await db.execute<RowDataPacket[]>(
      `WITH statement_rows AS (
         SELECT l.id,l.transaction_date,l.description,l.reference,
           l.balance-COALESCE(LAG(l.balance) OVER(PARTITION BY s.id ORDER BY l.line_number),s.opening_balance) movement
         FROM bank_statement_lines l JOIN bank_statements s ON s.id=l.bank_statement_id
         WHERE s.company_id=? AND s.bank_account_id=?
       ), candidates AS (
         SELECT sr.id statement_line_id,jl.id journal_line_id,j.journal_date,j.journal_number,j.reference journal_reference,jl.description journal_description,
           sr.movement,jl.debit-jl.credit journal_movement,
           ABS(DATEDIFF(sr.transaction_date,j.journal_date)) date_distance,
           CASE WHEN COALESCE(sr.reference,'')<>'' AND (j.reference=sr.reference OR j.journal_number=sr.reference) THEN 100 ELSE 0 END
             + CASE WHEN sr.transaction_date=j.journal_date THEN 30 ELSE 20-ABS(DATEDIFF(sr.transaction_date,j.journal_date))*5 END score,
           ROW_NUMBER() OVER(PARTITION BY sr.id ORDER BY
             CASE WHEN COALESCE(sr.reference,'')<>'' AND (j.reference=sr.reference OR j.journal_number=sr.reference) THEN 1 ELSE 0 END DESC,
             ABS(DATEDIFF(sr.transaction_date,j.journal_date)),j.id,jl.id) candidate_rank,
           COUNT(*) OVER(PARTITION BY sr.id) candidate_count
         FROM statement_rows sr
         JOIN journal_lines jl ON jl.account_id=? AND jl.debit-jl.credit=sr.movement
         JOIN journals j ON j.id=jl.journal_id AND j.company_id=? AND j.status IN('posted','reversed')
         WHERE sr.transaction_date BETWEEN ? AND ? AND ABS(DATEDIFF(sr.transaction_date,j.journal_date))<=3
           AND NOT EXISTS(SELECT 1 FROM bank_reconciliation_matches m WHERE m.bank_statement_line_id=sr.id AND m.status='confirmed')
           AND NOT EXISTS(SELECT 1 FROM bank_reconciliation_matches m WHERE m.journal_line_id=jl.id AND m.status='confirmed')
       )
       SELECT * FROM candidates WHERE candidate_rank=1 ORDER BY score DESC,statement_line_id`,
      [companyId, filter.bank_account_id, banks[0].gl_account_id, companyId, filter.date_from, filter.date_to],
    )
    return rows.map((row) => ({ ...row, confidence: Number(row.score) >= 100 ? 'high' : Number(row.candidate_count) === 1 && Number(row.date_distance) <= 1 ? 'high' : 'review' }))
  }
  create(companyId: number, input: z.output<typeof statementSchema>, context: PostingContext) {
    return idempotentOperation(
      companyId,
      input.request_key,
      'bank-statement',
      input,
      (connection) =>
        new BankStatementService().create(
          connection,
          {
            companyId,
            bankAccountId: input.bank_account_id,
            statementNumber: input.number,
            periodStart: input.date_from,
            periodEnd: input.date_to,
            openingBalance: input.opening_balance,
            closingBalance: input.closing_balance,
            status: 'imported',
            lines: input.lines.map((l, i) => ({
              lineNumber: i + 1,
              transactionDate: l.date,
              description: l.description,
              reference: l.reference,
              debit: l.debit,
              credit: l.credit,
              balance: l.balance,
            })),
          },
          context,
        ),
    )
  }
  match(companyId: number, input: z.output<typeof bankMatchSchema>, context: PostingContext) {
    return idempotentOperation(
      companyId,
      input.request_key,
      'bank-match',
      input,
      async (connection) => {
        const [statementRows] = await connection.execute<RowDataPacket[]>(
          `SELECT l.*,s.company_id,s.bank_account_id,s.period_end,s.period_start,s.closing_balance,s.opening_balance,b.gl_account_id FROM bank_statement_lines l JOIN bank_statements s ON s.id=l.bank_statement_id JOIN bank_accounts b ON b.id=s.bank_account_id AND b.company_id=s.company_id WHERE l.id=? AND s.company_id=? FOR UPDATE`,
          [input.statement_line_id, companyId],
        )
        const line = statementRows[0]
        if (!line) throw new NotFoundError('Mutasi bank tidak ditemukan')
        if (line.reconciliation_status !== 'unmatched')
          throw new ConflictError('Mutasi bank sudah dicocokkan atau diabaikan')
        const [previous] = await connection.execute<RowDataPacket[]>(
          'SELECT balance FROM bank_statement_lines WHERE bank_statement_id=? AND line_number<? ORDER BY line_number DESC LIMIT 1',
          [line.bank_statement_id, line.line_number],
        )
        const movement = subtractDecimal(
          String(line.balance),
          String(previous[0]?.balance ?? line.opening_balance),
        )
        const [journals] = await connection.execute<RowDataPacket[]>(
          `SELECT l.*,j.journal_date FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE l.id=? AND j.company_id=? AND j.status IN ('posted','reversed') AND l.account_id=? FOR UPDATE`,
          [input.journal_line_id, companyId, line.gl_account_id],
        )
        const journal = journals[0]
        if (!journal) throw new ValidationError('Pilih jurnal posted pada rekening yang sama')
        if (
          compareDecimal(
            movement,
            subtractDecimal(String(journal.debit), String(journal.credit)),
          ) !== 0
        )
          throw new ValidationError('Nilai dan arah mutasi bank harus sama persis dengan jurnal')
        const [used] = await connection.execute<RowDataPacket[]>(
          `SELECT id FROM bank_reconciliation_matches WHERE journal_line_id=? AND status='confirmed'`,
          [input.journal_line_id],
        )
        if (used.length) throw new ConflictError('Baris jurnal sudah dicocokkan')
        const [book] = await connection.execute<RowDataPacket[]>(
          `SELECT COALESCE(SUM(l.debit-l.credit),0) balance FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.company_id=? AND j.status IN ('posted','reversed') AND j.journal_date<=? AND l.account_id=?`,
          [companyId, line.period_end, line.gl_account_id],
        )
        const bookBalance = String(book[0]!.balance),
          difference = subtractDecimal(bookBalance, String(line.closing_balance))
        await connection.execute(
          `INSERT INTO bank_reconciliations(company_id,reconciliation_number,bank_account_id,bank_statement_id,reconciliation_date,book_balance,bank_balance,difference,status,created_by) VALUES(?,?,?,?,?,?,?,?,'draft',?) ON DUPLICATE KEY UPDATE book_balance=VALUES(book_balance),bank_balance=VALUES(bank_balance),difference=VALUES(difference)`,
          [
            companyId,
            `REC-${line.bank_statement_id}`,
            line.bank_account_id,
            line.bank_statement_id,
            line.period_end,
            bookBalance,
            line.closing_balance,
            difference,
            context.userId,
          ],
        )
        const [recs] = await connection.execute<RowDataPacket[]>(
          'SELECT id FROM bank_reconciliations WHERE bank_statement_id=? AND company_id=? FOR UPDATE',
          [line.bank_statement_id, companyId],
        )
        const amount = compareDecimal(movement, '0') > 0 ? movement : subtractDecimal('0', movement)
        await connection.execute(
          `INSERT INTO bank_reconciliation_matches(bank_reconciliation_id,bank_statement_line_id,journal_line_id,matched_amount,match_type,status,confirmed_by,confirmed_at,created_by) VALUES(?,?,?,?,'manual','confirmed',?,NOW(),?) ON DUPLICATE KEY UPDATE status='confirmed',matched_amount=VALUES(matched_amount),confirmed_by=VALUES(confirmed_by),confirmed_at=NOW()`,
          [
            recs[0]!.id,
            input.statement_line_id,
            input.journal_line_id,
            amount,
            context.userId,
            context.userId,
          ],
        )
        await connection.execute(
          `UPDATE bank_statement_lines SET reconciliation_status='matched',matched_amount=? WHERE id=?`,
          [amount, input.statement_line_id],
        )
        const [unmatched] = await connection.execute<RowDataPacket[]>(
          `SELECT COUNT(*) n FROM bank_statement_lines WHERE bank_statement_id=? AND reconciliation_status<>'matched'`,
          [line.bank_statement_id],
        )
        const [unmatchedBook] = await connection.execute<RowDataPacket[]>(
          `SELECT COUNT(*) n FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.company_id=? AND j.status IN ('posted','reversed') AND l.account_id=? AND j.journal_date BETWEEN ? AND ? AND NOT EXISTS(SELECT 1 FROM bank_reconciliation_matches m WHERE m.journal_line_id=l.id AND m.status='confirmed')`,
          [companyId, line.gl_account_id, line.period_start, line.period_end],
        )
        const completed =
          Number(unmatched[0]!.n) === 0 &&
          Number(unmatchedBook[0]!.n) === 0 &&
          compareDecimal(difference, '0') === 0
        await connection.execute(
          `UPDATE bank_reconciliations SET status=?,completed_by=?,completed_at=IF(?,NOW(),NULL),reconciled_book_balance=?,reconciled_bank_balance=? WHERE id=?`,
          [
            completed ? 'completed' : 'draft',
            completed ? context.userId : null,
            completed,
            bookBalance,
            line.closing_balance,
            recs[0]!.id,
          ],
        )
        await new AuditService().log(connection, {
          companyId,
          userId: context.userId,
          module: 'bank-reconciliation',
          action: 'match',
          recordType: 'bank_statement_line',
          recordId: input.statement_line_id,
          newValue: { journalLineId: input.journal_line_id, completed, difference },
        })
        return { matched: true, completed, difference }
      },
    )
  }
  unmatch(companyId: number, input: z.output<typeof bankUnmatchSchema>, context: PostingContext) {
    return idempotentOperation(
      companyId,
      input.request_key,
      'bank-unmatch',
      input,
      async (connection) => {
        const [rows] = await connection.execute<RowDataPacket[]>(
          `SELECT l.id,l.bank_statement_id FROM bank_statement_lines l JOIN bank_statements s ON s.id=l.bank_statement_id WHERE l.id=? AND s.company_id=? FOR UPDATE`,
          [input.statement_line_id, companyId],
        )
        if (!rows[0]) throw new NotFoundError('Mutasi tidak ditemukan')
        await connection.execute(
          `UPDATE bank_reconciliation_matches SET status='rejected' WHERE bank_statement_line_id=? AND status='confirmed'`,
          [input.statement_line_id],
        )
        await connection.execute(
          `UPDATE bank_statement_lines SET reconciliation_status='unmatched',matched_amount=0 WHERE id=?`,
          [input.statement_line_id],
        )
        await connection.execute(
          `UPDATE bank_reconciliations SET status='reopened',reopened_by=?,reopened_at=NOW(),completed_by=NULL,completed_at=NULL WHERE bank_statement_id=? AND company_id=?`,
          [context.userId, rows[0].bank_statement_id, companyId],
        )
        await new AuditService().log(connection, {
          companyId,
          userId: context.userId,
          module: 'bank-reconciliation',
          action: 'unmatch',
          recordType: 'bank_statement_line',
          recordId: input.statement_line_id,
        })
        return { unmatched: true }
      },
    )
  }
}
