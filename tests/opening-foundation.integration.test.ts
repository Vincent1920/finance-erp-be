import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { db, transaction } from '../config/database'
import { OpeningBalanceService } from '../services/OpeningBalanceService'
import { JournalService } from '../services/JournalService'
import { PostingService } from '../services/PostingService'
import { ReportingService } from '../services/ReportingService'
import { ReportRepository } from '../repositories/ReportRepository'
import { ReconciliationWorkspaceService } from '../services/ReconciliationWorkspaceService'
import { SettlementService } from '../services/SettlementService'
import { settlementSchema } from '../validators/operations.validator'

const integration = process.env.RUN_FOUNDATION_DB_TESTS === '1' ? test : test.skip
integration(
  'opening approval, idempotent preparation, period protection and historical profit after closing',
  async () => {
    const marker = `Foundation verification ${randomUUID()}`
    const [company] = await db.execute<ResultSetHeader>('INSERT INTO companies(name) VALUES(?)', [
      marker,
    ])
    const cid = company.insertId
    try {
      const users: number[] = [],
        accounts: number[] = []
      for (const name of ['maker', 'checker']) {
        const [u] = await db.execute<ResultSetHeader>(
          'INSERT INTO users(company_id,name,email,password) VALUES(?,?,?,?)',
          [cid, name, `${randomUUID()}@example.invalid`, 'test-no-login'],
        )
        users.push(u.insertId)
      }
      for (const [code, type, normal] of [
        ['1001', 'asset', 'debit'],
        ['3001', 'equity', 'credit'],
        ['4001', 'revenue', 'credit'],
      ]) {
        const [a] = await db.execute<ResultSetHeader>(
          'INSERT INTO accounts(company_id,code,name,account_type,normal_balance) VALUES(?,?,?,?,?)',
          [cid, code, code, type, normal],
        )
        accounts.push(a.insertId)
      }
      await db.execute(
        'INSERT INTO accounting_periods(company_id,year,month,start_date,end_date) VALUES(?,2026,10,?,?)',
        [cid, '2026-10-01', '2026-10-31'],
      )
      const maker = { userId: users[0]! },
        checker = { userId: users[1]! },
        opening = new OpeningBalanceService(),
        journals = new JournalService(),
        posting = new PostingService(),
        reports = new ReportingService()
      const batch = await transaction((c) =>
        opening.createGeneralLedger(
          c,
          {
            companyId: cid,
            batchNumber: 'OPEN-01',
            asOfDate: '2026-10-01',
            lines: [
              { accountId: accounts[0]!, debit: '1000', credit: '0' },
              { accountId: accounts[1]!, debit: '0', credit: '1000' },
            ],
          },
          maker,
        ),
      )
      const prepared = await opening.prepareJournal(cid, batch.id, maker)
      expect((await opening.prepareJournal(cid, batch.id, maker)).id).toBe(prepared.id)
      await expect(opening.prepareJournal(cid + 999999, batch.id, maker)).rejects.toThrow(
        'tidak ditemukan',
      )
      await expect(posting.postManual(prepared.id, cid, maker)).rejects.toThrow('disetujui')
      await journals.submit(prepared.id, cid, maker)
      await journals.approve(prepared.id, cid, checker)
      await posting.postManual(prepared.id, cid, maker)
      expect((await opening.detail(cid, batch.id)).status).toBe('posted')
      await expect(posting.postManual(prepared.id, cid, maker)).rejects.toThrow('pernah')
      const range = { dateFrom: '2026-10-01', dateTo: '2026-10-31' }
      await transaction((c) =>
        posting.createPostedJournal(c, {
          companyId: cid,
          sourceType: 'test_sale',
          sourceId: 1,
          date: '2026-10-02',
          description: 'Revenue test',
          context: maker,
          lines: [
            { accountId: accounts[0]!, debit: '250', credit: '0' },
            { accountId: accounts[2]!, debit: '0', credit: '250' },
          ],
        }),
      )
      expect((await reports.profitLoss(cid, range)).netProfit).toBe('250.00')
      await db.execute("UPDATE accounting_periods SET status='closed' WHERE company_id=?", [cid])
      const closing = await transaction((c) =>
        posting.createPostedJournal(c, {
          companyId: cid,
          sourceType: 'year_end_closing',
          sourceId: 1,
          date: '2026-10-31',
          description: 'Close revenue test',
          context: maker,
          lines: [
            { accountId: accounts[2]!, debit: '250', credit: '0' },
            { accountId: accounts[1]!, debit: '0', credit: '250' },
          ],
        }),
      )
      expect((await reports.profitLoss(cid, range)).netProfit).toBe('250.00')
      const balances = await new ReportRepository().accountMovements(cid, range)
      const revenue = balances.find((a) => Number(a.id) === accounts[2])!
      expect(Number(revenue.debit) - Number(revenue.credit)).toBe(0)
      await transaction((c) =>
        posting.reversePostedJournal(c, {
          companyId: cid,
          journalId: closing,
          date: '2026-10-31',
          reason: 'Test reopen',
          context: checker,
          sourceType: 'year_end_closing_reversal',
        }),
      )
      expect((await reports.profitLoss(cid, range)).netProfit).toBe('250.00')
      await expect(
        opening.prepareJournal(
          cid,
          (
            await transaction((c) =>
              opening.createGeneralLedger(
                c,
                {
                  companyId: cid,
                  batchNumber: 'CLOSED',
                  asOfDate: '2026-10-03',
                  lines: [
                    { accountId: accounts[0]!, debit: 1, credit: 0 },
                    { accountId: accounts[1]!, debit: 0, credit: 1 },
                  ],
                },
                maker,
              ),
            )
          ).id,
          maker,
        ),
      ).rejects.toThrow('tidak terbuka')
      await db.execute("UPDATE accounting_periods SET status='open' WHERE company_id=?", [cid])
      await posting.reverseManual({
        companyId: cid,
        journalId: prepared.id,
        date: '2026-10-04',
        reason: 'Reverse opening test',
        context: checker,
      })
      expect((await opening.detail(cid, batch.id)).status).toBe('reversed')
      for (const sales of [true, false]) {
        const party = sales ? 'customer' : 'supplier',
          kind = sales ? 'sales' : 'purchase',
          key = sales ? 'receivable' : 'payable'
        const controlIds: number[] = []
        for (const n of [1, 2, 3]) {
          const [a] = await db.execute<ResultSetHeader>(
            'INSERT INTO accounts(company_id,code,name,account_type,normal_balance) VALUES(?,?,?,?,?)',
            [
              cid,
              `${sales ? '11' : '21'}${n}0`,
              `${party} control ${n}`,
              sales ? 'asset' : 'liability',
              sales ? 'debit' : 'credit',
            ],
          )
          controlIds.push(a.insertId)
        }
        const [p] = await db.execute<ResultSetHeader>(
          `INSERT INTO ${party}s(company_id,code,name,${key}_account_id) VALUES(?,?,?,?)`,
          [cid, 'TEST', party, controlIds[2]!],
        )
        const invoiceIds: number[] = []
        for (const n of [0, 1]) {
          const [i] = await db.execute<ResultSetHeader>(
            `INSERT INTO ${kind}_invoices(company_id,invoice_number,invoice_date,due_date,${party}_id,subtotal,grand_total,base_grand_total,outstanding_amount,status,control_account_id,created_by) VALUES(?,?,'2026-10-01','2026-10-31',?,100,100,100,100,'posted',?,?)`,
            [cid, `TEST-${n}`, p.insertId, controlIds[n]!, maker.userId],
          )
          invoiceIds.push(i.insertId)
        }
        const payment = await new SettlementService().post(
          cid,
          sales,
          settlementSchema.parse({
            request_key: randomUUID(),
            date: '2026-10-05',
            cash_account_id: accounts[0],
            allocations: invoiceIds.map((invoice_id) => ({ invoice_id, amount: 100 })),
          }),
          maker,
        )
        const [jl] = await db.execute<RowDataPacket[]>(
          'SELECT account_id,debit,credit FROM journal_lines WHERE journal_id=?',
          [payment.journalId],
        )
        expect(jl.some((l) => Number(l.account_id) === controlIds[2])).toBe(false)
        for (const account of controlIds.slice(0, 2))
          expect(
            jl.some(
              (l) => Number(l.account_id) === account && Number(sales ? l.credit : l.debit) === 100,
            ),
          ).toBe(true)
        const [settled] = await db.execute<RowDataPacket[]>(
          `SELECT outstanding_amount FROM ${kind}_invoices WHERE company_id=?`,
          [cid],
        )
        expect(settled.every((i) => Number(i.outstanding_amount) === 0)).toBe(true)
        const reconciliation = await new ReportRepository().subledgerReconciliation(
          cid,
          '2026-10-31',
        )
        for (const account of controlIds.slice(0, 2)) {
          const row = reconciliation.find(
            (r) =>
              Number(r.account_id) === account && r.reconciliation_type === (sales ? 'ar' : 'ap'),
          )
          expect(row).toBeDefined()
          expect(Number(row!.subledger)).toBe(0)
          const detail = await new ReconciliationWorkspaceService().detail(
            cid,
            sales ? 'ar' : 'ap',
            account,
            '2026-10-31',
          )
          expect(detail.sources.length).toBe(2)
        }
      }
    } finally {
      const [ownership] = await db.execute<RowDataPacket[]>(
        'SELECT name FROM companies WHERE id=?',
        [cid],
      )
      if (ownership[0]?.name !== marker) throw new Error('Refusing unrelated cleanup')
      for (const party of ['customer', 'supplier']) {
        await db.execute(
          `DELETE a FROM ${party}_payment_allocations a JOIN ${party}_payments p ON p.id=a.${party}_payment_id WHERE p.company_id=?`,
          [cid],
        )
        await db.execute(`DELETE FROM ${party}_payments WHERE company_id=?`, [cid])
      }
      for (const table of ['sales_invoices', 'purchase_invoices', 'customers', 'suppliers'])
        await db.execute(`DELETE FROM ${table} WHERE company_id=?`, [cid])
      await db.execute('DELETE FROM opening_balance_batches WHERE company_id=?', [cid])
      await db.execute(
        'DELETE l FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.company_id=?',
        [cid],
      )
      await db.execute(
        'UPDATE journals SET original_journal_id=NULL,reversal_journal_id=NULL WHERE company_id=?',
        [cid],
      )
      for (const table of [
        'journals',
        'audit_logs',
        'operation_requests',
        'number_sequences',
        'accounting_periods',
        'accounts',
        'users',
      ])
        await db.execute(`DELETE FROM ${table} WHERE company_id=?`, [cid])
      await db.execute('DELETE FROM companies WHERE id=? AND name=?', [cid, marker])
      await db.end()
    }
  },
  30000,
)
