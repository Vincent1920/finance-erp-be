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
  bankMatchBatchSchema,
  bankUnmatchSchema,
  bankMatchingRuleSchema,
  bankImportMappingSchema,
} from '../validators/operations.validator'
type Filter = z.output<typeof bankingQuerySchema>
export class BankingService {
  private async validateNative(companyId: number, accountId: number) {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT b.currency FROM bank_accounts b JOIN companies c ON c.id=b.company_id WHERE b.company_id=? AND b.gl_account_id=? AND b.deleted_at IS NULL AND b.currency<>c.base_currency`,
      [companyId, accountId],
    )
    if (!rows.length) return
    const [unknown] = await db.execute<RowDataPacket[]>(
      `SELECT l.id FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.company_id=? AND l.account_id=? AND j.status IN('posted','reversed') AND (l.currency_code IS NULL OR l.currency_code<>?) LIMIT 1`,
      [companyId, accountId, rows[0]!.currency],
    )
    if (unknown.length)
      throw new ConflictError(
        'Rekening valas memiliki jurnal tanpa nominal valuta asal. Lengkapi migrasi data sebelum rekonsiliasi.',
      )
  }
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
    await this.validateNative(companyId, account)
    const [summary] = await db.execute<RowDataPacket[]>(
      `SELECT COALESCE(SUM(CASE WHEN j.journal_date<? THEN (CASE WHEN l.currency_code IS NULL THEN l.debit-l.credit ELSE l.currency_debit-l.currency_credit END) ELSE 0 END),0) opening,COALESCE(SUM(CASE WHEN j.journal_date>=? THEN (CASE WHEN l.currency_code IS NULL THEN l.debit ELSE l.currency_debit END) ELSE 0 END),0) inflow,COALESCE(SUM(CASE WHEN j.journal_date>=? THEN (CASE WHEN l.currency_code IS NULL THEN l.credit ELSE l.currency_credit END) ELSE 0 END),0) outflow,COALESCE(SUM((CASE WHEN l.currency_code IS NULL THEN l.debit-l.credit ELSE l.currency_debit-l.currency_credit END)),0) closing FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.company_id=? AND j.status IN ('posted','reversed') AND l.account_id=? AND j.journal_date<=?`,
      [filter.date_from, filter.date_from, filter.date_from, companyId, account, filter.date_to],
    )
    const [rows] = await db.execute<RowDataPacket[]>(
      `WITH ledger AS(SELECT l.id,j.id journal_id,j.journal_date date,j.journal_number number,j.source_type,j.source_id,(SELECT p.period FROM payroll_runs p WHERE p.id=j.source_id AND p.company_id=j.company_id AND j.source_type IN ('payroll','payroll_payment')) source_period,j.reference,l.description,CASE WHEN l.currency_code IS NULL THEN l.debit ELSE l.currency_debit END debit,CASE WHEN l.currency_code IS NULL THEN l.credit ELSE l.currency_credit END credit,SUM((CASE WHEN l.currency_code IS NULL THEN l.debit-l.credit ELSE l.currency_debit-l.currency_credit END)) OVER(ORDER BY j.journal_date,j.id,l.id) balance FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.company_id=? AND j.status IN ('posted','reversed') AND l.account_id=? AND j.journal_date<=?) SELECT ledger.*,COALESCE((SELECT SUM(m.matched_amount) FROM bank_reconciliation_matches m WHERE m.journal_line_id=ledger.id AND m.status='confirmed'),0) matched_amount FROM ledger WHERE date>=? ORDER BY date,journal_id,id`,
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
    const [banks] = await db.execute<RowDataPacket[]>(
      'SELECT gl_account_id FROM bank_accounts WHERE id=? AND company_id=? AND is_active=TRUE AND deleted_at IS NULL',
      [filter.bank_account_id, companyId],
    )
    if (!banks[0]) throw new NotFoundError('Rekening bank tidak ditemukan')
    await this.validateNative(companyId, Number(banks[0].gl_account_id))
    const [rules] = await db.execute<RowDataPacket[]>(
      `SELECT * FROM bank_matching_rules
        WHERE company_id=? AND is_active=1 AND (bank_account_id IS NULL OR bank_account_id=?)
        ORDER BY priority,id`,
      [companyId, filter.bank_account_id],
    )
    const maxTolerance = Math.max(3, ...rules.map((rule) => Number(rule.date_tolerance_days)))
    const [rows] = await db.execute<RowDataPacket[]>(
      `WITH statement_rows AS (
         SELECT l.id,l.transaction_date,l.description,l.reference,
           l.balance-COALESCE(LAG(l.balance) OVER(PARTITION BY s.id ORDER BY l.line_number),s.opening_balance) movement
         FROM bank_statement_lines l JOIN bank_statements s ON s.id=l.bank_statement_id
         WHERE s.company_id=? AND s.bank_account_id=?
       ), candidates AS (
         SELECT sr.id statement_line_id,sr.description statement_description,sr.reference statement_reference,jl.id journal_line_id,j.journal_date,j.journal_number,j.reference journal_reference,jl.description journal_description,
           sr.movement,(CASE WHEN jl.currency_code IS NULL THEN jl.debit-jl.credit ELSE jl.currency_debit-jl.currency_credit END) journal_movement,
           ABS(DATEDIFF(sr.transaction_date,j.journal_date)) date_distance,
           CASE WHEN COALESCE(sr.reference,'')<>'' AND (j.reference=sr.reference OR j.journal_number=sr.reference) THEN 100 ELSE 0 END
             + CASE WHEN sr.transaction_date=j.journal_date THEN 30 ELSE 20-ABS(DATEDIFF(sr.transaction_date,j.journal_date))*5 END score,
           ROW_NUMBER() OVER(PARTITION BY sr.id ORDER BY
             CASE WHEN COALESCE(sr.reference,'')<>'' AND (j.reference=sr.reference OR j.journal_number=sr.reference) THEN 1 ELSE 0 END DESC,
             ABS(DATEDIFF(sr.transaction_date,j.journal_date)),j.id,jl.id) candidate_rank,
           COUNT(*) OVER(PARTITION BY sr.id) candidate_count
         FROM statement_rows sr
         JOIN journal_lines jl ON jl.account_id=? AND (CASE WHEN jl.currency_code IS NULL THEN jl.debit-jl.credit ELSE jl.currency_debit-jl.currency_credit END)=sr.movement
         JOIN journals j ON j.id=jl.journal_id AND j.company_id=? AND j.status IN('posted','reversed')
         WHERE sr.transaction_date BETWEEN ? AND ? AND ABS(DATEDIFF(sr.transaction_date,j.journal_date))<=?
           AND NOT EXISTS(SELECT 1 FROM bank_reconciliation_matches m WHERE m.bank_statement_line_id=sr.id AND m.status='confirmed')
           AND NOT EXISTS(SELECT 1 FROM bank_reconciliation_matches m WHERE m.journal_line_id=jl.id AND m.status='confirmed')
       )
       SELECT * FROM candidates WHERE candidate_rank=1 ORDER BY score DESC,statement_line_id`,
      [
        companyId,
        filter.bank_account_id,
        banks[0].gl_account_id,
        companyId,
        filter.date_from,
        filter.date_to,
        maxTolerance,
      ],
    )
    return rows.map((row) => {
      const movement = Number(row.movement)
      const description = String(row.statement_description ?? '').toLowerCase()
      const reference = String(row.statement_reference ?? '').toLowerCase()
      const matchedRule = rules.find((rule) => {
        const amount = Math.abs(movement)
        return (
          Number(row.date_distance) <= Number(rule.date_tolerance_days) &&
          (rule.direction === 'any' ||
            (rule.direction === 'inflow' && movement > 0) ||
            (rule.direction === 'outflow' && movement < 0)) &&
          (!rule.description_pattern ||
            description.includes(String(rule.description_pattern).toLowerCase())) &&
          (!rule.reference_pattern ||
            reference.includes(String(rule.reference_pattern).toLowerCase())) &&
          (rule.amount_min == null || amount >= Number(rule.amount_min)) &&
          (rule.amount_max == null || amount <= Number(rule.amount_max))
        )
      })
      const score = Number(row.score) + (matchedRule ? 40 : 0)
      return {
        ...row,
        score,
        matched_rule_id: matchedRule ? Number(matchedRule.id) : null,
        matched_rule_name: matchedRule?.name ?? null,
        confidence:
          score >= 100 ||
          (matchedRule && Number(row.candidate_count) === 1) ||
          (Number(row.candidate_count) === 1 && Number(row.date_distance) <= 1)
            ? 'high'
            : 'review',
      }
    })
  }

  async matchingRules(companyId: number) {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT r.*,b.bank_name,b.account_number
         FROM bank_matching_rules r LEFT JOIN bank_accounts b ON b.id=r.bank_account_id
        WHERE r.company_id=? ORDER BY r.priority,r.name`,
      [companyId],
    )
    return rows
  }

  async saveMatchingRule(
    companyId: number,
    input: z.output<typeof bankMatchingRuleSchema>,
    context: PostingContext,
  ) {
    if (input.id) {
      const [result] = await db.execute<ResultSetHeader>(
        `UPDATE bank_matching_rules SET name=?,bank_account_id=?,priority=?,direction=?,description_pattern=?,reference_pattern=?,amount_min=?,amount_max=?,date_tolerance_days=?,is_active=? WHERE id=? AND company_id=?`,
        [
          input.name,
          input.bank_account_id ?? null,
          input.priority,
          input.direction,
          input.description_pattern || null,
          input.reference_pattern || null,
          input.amount_min ?? null,
          input.amount_max ?? null,
          input.date_tolerance_days,
          input.is_active,
          input.id,
          companyId,
        ],
      )
      if (!result.affectedRows) throw new NotFoundError('Aturan pencocokan tidak ditemukan')
      return { id: input.id }
    }
    const [result] = await db.execute<ResultSetHeader>(
      `INSERT INTO bank_matching_rules(company_id,name,bank_account_id,priority,direction,description_pattern,reference_pattern,amount_min,amount_max,date_tolerance_days,is_active,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        companyId,
        input.name,
        input.bank_account_id ?? null,
        input.priority,
        input.direction,
        input.description_pattern || null,
        input.reference_pattern || null,
        input.amount_min ?? null,
        input.amount_max ?? null,
        input.date_tolerance_days,
        input.is_active,
        context.userId,
      ],
    )
    return { id: Number(result.insertId) }
  }

  async deleteMatchingRule(companyId: number, id: number) {
    const [result] = await db.execute<ResultSetHeader>(
      'DELETE FROM bank_matching_rules WHERE id=? AND company_id=?',
      [id, companyId],
    )
    if (!result.affectedRows) throw new NotFoundError('Aturan pencocokan tidak ditemukan')
    return { id }
  }

  async importMappings(companyId: number) {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT m.*,b.bank_name,b.account_number
         FROM bank_import_mappings m LEFT JOIN bank_accounts b ON b.id=m.bank_account_id
        WHERE m.company_id=? ORDER BY m.is_default DESC,m.name`,
      [companyId],
    )
    return rows.map((row) => ({
      ...row,
      column_mapping:
        typeof row.column_mapping === 'string'
          ? JSON.parse(row.column_mapping)
          : row.column_mapping,
    }))
  }

  async saveImportMapping(
    companyId: number,
    input: z.output<typeof bankImportMappingSchema>,
    context: PostingContext,
  ) {
    if (input.is_default)
      await db.execute(
        'UPDATE bank_import_mappings SET is_default=0 WHERE company_id=? AND (bank_account_id<=>?)',
        [companyId, input.bank_account_id ?? null],
      )
    const mapping = JSON.stringify(input.column_mapping)
    if (input.id) {
      const [result] = await db.execute<ResultSetHeader>(
        `UPDATE bank_import_mappings SET name=?,bank_account_id=?,delimiter=?,date_format=?,decimal_separator=?,header_row=?,column_mapping=?,is_default=?,is_active=? WHERE id=? AND company_id=?`,
        [
          input.name,
          input.bank_account_id ?? null,
          input.delimiter,
          input.date_format,
          input.decimal_separator,
          input.header_row,
          mapping,
          input.is_default,
          input.is_active,
          input.id,
          companyId,
        ],
      )
      if (!result.affectedRows) throw new NotFoundError('Pemetaan impor tidak ditemukan')
      return { id: input.id }
    }
    const [result] = await db.execute<ResultSetHeader>(
      `INSERT INTO bank_import_mappings(company_id,name,bank_account_id,delimiter,date_format,decimal_separator,header_row,column_mapping,is_default,is_active,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [
        companyId,
        input.name,
        input.bank_account_id ?? null,
        input.delimiter,
        input.date_format,
        input.decimal_separator,
        input.header_row,
        mapping,
        input.is_default,
        input.is_active,
        context.userId,
      ],
    )
    return { id: Number(result.insertId) }
  }

  async deleteImportMapping(companyId: number, id: number) {
    const [result] = await db.execute<ResultSetHeader>(
      'DELETE FROM bank_import_mappings WHERE id=? AND company_id=?',
      [id, companyId],
    )
    if (!result.affectedRows) throw new NotFoundError('Pemetaan impor tidak ditemukan')
    return { id }
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
        await this.validateNative(companyId, Number(line.gl_account_id))
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
            subtractDecimal(
              String(journal.currency_code ? journal.currency_debit : journal.debit),
              String(journal.currency_code ? journal.currency_credit : journal.credit),
            ),
          ) !== 0
        )
          throw new ValidationError('Nilai dan arah mutasi bank harus sama persis dengan jurnal')
        const [used] = await connection.execute<RowDataPacket[]>(
          `SELECT id FROM bank_reconciliation_matches WHERE journal_line_id=? AND status='confirmed'`,
          [input.journal_line_id],
        )
        if (used.length) throw new ConflictError('Baris jurnal sudah dicocokkan')
        const [book] = await connection.execute<RowDataPacket[]>(
          `SELECT COALESCE(SUM((CASE WHEN l.currency_code IS NULL THEN l.debit-l.credit ELSE l.currency_debit-l.currency_credit END)),0) balance FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.company_id=? AND j.status IN ('posted','reversed') AND j.journal_date<=? AND l.account_id=?`,
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
          `SELECT COUNT(*) n FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.company_id=? AND j.status IN ('posted','reversed') AND l.account_id=? AND j.journal_date BETWEEN ? AND ? AND (CASE WHEN l.currency_code IS NULL THEN l.debit-l.credit ELSE l.currency_debit-l.currency_credit END)<>0 AND NOT EXISTS(SELECT 1 FROM bank_reconciliation_matches m WHERE m.journal_line_id=l.id AND m.status='confirmed')`,
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
  matchBatch(
    companyId: number,
    input: z.output<typeof bankMatchBatchSchema>,
    context: PostingContext,
  ) {
    return idempotentOperation(
      companyId,
      input.request_key,
      'bank-match-batch',
      input,
      async (connection) => {
        const duplicatePairs = new Set<string>()
        for (const allocation of input.allocations) {
          const key = `${allocation.statement_line_id}:${allocation.journal_line_id}`
          if (duplicatePairs.has(key))
            throw new ValidationError('Pasangan mutasi dan jurnal tidak boleh berulang')
          duplicatePairs.add(key)
        }

        const statementIds = [
          ...new Set(input.allocations.map((row) => row.statement_line_id)),
        ].sort((a, b) => a - b)
        const journalIds = [...new Set(input.allocations.map((row) => row.journal_line_id))].sort(
          (a, b) => a - b,
        )
        const [statementRows] = await connection.execute<RowDataPacket[]>(
          `SELECT l.*,s.company_id,s.bank_account_id,s.period_end,s.period_start,s.closing_balance,s.opening_balance,b.gl_account_id,
                  l.balance-COALESCE((SELECT p.balance FROM bank_statement_lines p WHERE p.bank_statement_id=l.bank_statement_id AND p.line_number<l.line_number ORDER BY p.line_number DESC LIMIT 1),s.opening_balance) movement
             FROM bank_statement_lines l
             JOIN bank_statements s ON s.id=l.bank_statement_id
             JOIN bank_accounts b ON b.id=s.bank_account_id AND b.company_id=s.company_id
            WHERE l.id IN (${statementIds.map(() => '?').join(',')}) AND s.company_id=? FOR UPDATE`,
          [...statementIds, companyId],
        )
        if (statementRows.length !== statementIds.length)
          throw new NotFoundError('Salah satu mutasi bank tidak ditemukan')
        const glAccounts = new Set(statementRows.map((row) => Number(row.gl_account_id)))
        if (glAccounts.size !== 1)
          throw new ValidationError('Satu batch hanya dapat memakai rekening bank yang sama')
        const glAccountId = Number(statementRows[0]!.gl_account_id)
        await this.validateNative(companyId, glAccountId)
        const [journalRows] = await connection.execute<RowDataPacket[]>(
          `SELECT l.*,CASE WHEN l.currency_code IS NULL THEN l.debit ELSE l.currency_debit END debit,CASE WHEN l.currency_code IS NULL THEN l.credit ELSE l.currency_credit END credit,j.journal_date,j.journal_number
             FROM journal_lines l JOIN journals j ON j.id=l.journal_id
            WHERE l.id IN (${journalIds.map(() => '?').join(',')}) AND j.company_id=?
              AND j.status IN ('posted','reversed') AND l.account_id=? FOR UPDATE`,
          [...journalIds, companyId, glAccountId],
        )
        if (journalRows.length !== journalIds.length)
          throw new ValidationError('Salah satu jurnal tidak posted atau memakai rekening berbeda')

        const statementMap = new Map(statementRows.map((row) => [Number(row.id), row]))
        const journalMap = new Map(journalRows.map((row) => [Number(row.id), row]))
        const [existing] = await connection.execute<RowDataPacket[]>(
          `SELECT bank_statement_line_id,journal_line_id,SUM(matched_amount) matched_amount
             FROM bank_reconciliation_matches
            WHERE status='confirmed' AND (bank_statement_line_id IN (${statementIds.map(() => '?').join(',')}) OR journal_line_id IN (${journalIds.map(() => '?').join(',')}))
            GROUP BY bank_statement_line_id,journal_line_id`,
          [...statementIds, ...journalIds],
        )
        const usedStatement = new Map<number, number>()
        const usedJournal = new Map<number, number>()
        for (const row of existing) {
          usedStatement.set(
            Number(row.bank_statement_line_id),
            (usedStatement.get(Number(row.bank_statement_line_id)) ?? 0) +
              Number(row.matched_amount),
          )
          usedJournal.set(
            Number(row.journal_line_id),
            (usedJournal.get(Number(row.journal_line_id)) ?? 0) + Number(row.matched_amount),
          )
        }
        for (const allocation of input.allocations) {
          const statement = statementMap.get(allocation.statement_line_id)!
          const journal = journalMap.get(allocation.journal_line_id)!
          const statementMovement = Number(statement.movement)
          const journalMovement = Number(journal.debit) - Number(journal.credit)
          if (Math.sign(statementMovement) !== Math.sign(journalMovement))
            throw new ValidationError(
              `Arah transaksi ${statement.description} tidak sama dengan jurnal ${journal.journal_number}`,
            )
          const nextStatement =
            (usedStatement.get(allocation.statement_line_id) ?? 0) + allocation.matched_amount
          const nextJournal =
            (usedJournal.get(allocation.journal_line_id) ?? 0) + allocation.matched_amount
          if (nextStatement > Math.abs(statementMovement) + 0.005)
            throw new ValidationError(
              `Alokasi mutasi ${statement.description} melebihi nilai yang belum cocok`,
            )
          if (nextJournal > Math.abs(journalMovement) + 0.005)
            throw new ValidationError(
              `Alokasi jurnal ${journal.journal_number} melebihi nilai yang belum cocok`,
            )
          usedStatement.set(allocation.statement_line_id, nextStatement)
          usedJournal.set(allocation.journal_line_id, nextJournal)
        }

        const reconciliationIds = new Map<number, number>()
        for (const statement of statementRows) {
          const [book] = await connection.execute<RowDataPacket[]>(
            `SELECT COALESCE(SUM((CASE WHEN l.currency_code IS NULL THEN l.debit-l.credit ELSE l.currency_debit-l.currency_credit END)),0) balance FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.company_id=? AND j.status IN ('posted','reversed') AND j.journal_date<=? AND l.account_id=?`,
            [companyId, statement.period_end, statement.gl_account_id],
          )
          const bookBalance = String(book[0]!.balance)
          const difference = subtractDecimal(bookBalance, String(statement.closing_balance))
          await connection.execute(
            `INSERT INTO bank_reconciliations(company_id,reconciliation_number,bank_account_id,bank_statement_id,reconciliation_date,book_balance,bank_balance,difference,status,created_by)
             VALUES(?,?,?,?,?,?,?,?,'draft',?)
             ON DUPLICATE KEY UPDATE book_balance=VALUES(book_balance),bank_balance=VALUES(bank_balance),difference=VALUES(difference),status=IF(status='completed','reopened',status)`,
            [
              companyId,
              `REC-${statement.bank_statement_id}`,
              statement.bank_account_id,
              statement.bank_statement_id,
              statement.period_end,
              bookBalance,
              statement.closing_balance,
              difference,
              context.userId,
            ],
          )
          const [recs] = await connection.execute<RowDataPacket[]>(
            `SELECT id FROM bank_reconciliations WHERE bank_statement_id=? AND company_id=? FOR UPDATE`,
            [statement.bank_statement_id, companyId],
          )
          reconciliationIds.set(Number(statement.id), Number(recs[0]!.id))
        }
        for (const allocation of input.allocations) {
          await connection.execute(
            `INSERT INTO bank_reconciliation_matches(bank_reconciliation_id,bank_statement_line_id,journal_line_id,matched_amount,match_type,status,confirmed_by,confirmed_at,created_by)
             VALUES(?,?,?,?,'manual','confirmed',?,NOW(),?)
             ON DUPLICATE KEY UPDATE matched_amount=IF(status='confirmed',matched_amount+VALUES(matched_amount),VALUES(matched_amount)),status='confirmed',confirmed_by=VALUES(confirmed_by),confirmed_at=NOW()`,
            [
              reconciliationIds.get(allocation.statement_line_id)!,
              allocation.statement_line_id,
              allocation.journal_line_id,
              allocation.matched_amount,
              context.userId,
              context.userId,
            ],
          )
        }
        for (const statement of statementRows) {
          const matched = usedStatement.get(Number(statement.id)) ?? 0
          const total = Math.abs(Number(statement.movement))
          await connection.execute(
            `UPDATE bank_statement_lines SET matched_amount=?,reconciliation_status=? WHERE id=?`,
            [
              matched,
              Math.abs(matched - total) < 0.005 ? 'matched' : matched > 0 ? 'partial' : 'unmatched',
              statement.id,
            ],
          )
        }
        const statementsByFile = new Map<number, RowDataPacket>()
        for (const statement of statementRows)
          statementsByFile.set(Number(statement.bank_statement_id), statement)
        for (const statement of statementsByFile.values()) {
          const [unmatchedBank] = await connection.execute<RowDataPacket[]>(
            `SELECT COUNT(*) n FROM bank_statement_lines WHERE bank_statement_id=? AND reconciliation_status<>'matched'`,
            [statement.bank_statement_id],
          )
          const [unmatchedBook] = await connection.execute<RowDataPacket[]>(
            `SELECT COUNT(*) n
               FROM journal_lines l JOIN journals j ON j.id=l.journal_id
              WHERE j.company_id=? AND j.status IN ('posted','reversed') AND l.account_id=?
                AND j.journal_date BETWEEN ? AND ?
                AND ABS(ABS((CASE WHEN l.currency_code IS NULL THEN l.debit-l.credit ELSE l.currency_debit-l.currency_credit END))-COALESCE((SELECT SUM(m.matched_amount) FROM bank_reconciliation_matches m WHERE m.journal_line_id=l.id AND m.status='confirmed'),0))>0.005`,
            [companyId, statement.gl_account_id, statement.period_start, statement.period_end],
          )
          const [reconciliation] = await connection.execute<RowDataPacket[]>(
            `SELECT id,book_balance,bank_balance,difference FROM bank_reconciliations WHERE bank_statement_id=? AND company_id=?`,
            [statement.bank_statement_id, companyId],
          )
          const completed =
            Number(unmatchedBank[0]!.n) === 0 &&
            Number(unmatchedBook[0]!.n) === 0 &&
            compareDecimal(String(reconciliation[0]!.difference), '0') === 0
          await connection.execute(
            `UPDATE bank_reconciliations
                SET status=?,completed_by=?,completed_at=IF(?,NOW(),NULL),
                    reconciled_book_balance=book_balance,reconciled_bank_balance=bank_balance
              WHERE id=?`,
            [
              completed ? 'completed' : 'draft',
              completed ? context.userId : null,
              completed,
              reconciliation[0]!.id,
            ],
          )
        }
        await new AuditService().log(connection, {
          companyId,
          userId: context.userId,
          module: 'bank-reconciliation',
          action: 'match_batch',
          recordType: 'bank_reconciliation',
          recordId: null,
          newValue: {
            allocations: input.allocations,
            statementCount: statementIds.length,
            journalCount: journalIds.length,
          },
          requestId: context.requestId,
          ip: context.ip,
        })
        return {
          matched: true,
          allocations: input.allocations.length,
          statement_lines: statementIds.length,
          journal_lines: journalIds.length,
        }
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
