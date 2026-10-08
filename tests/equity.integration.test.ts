import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { db } from '../config/database'
import { EquityService } from '../services/EquityService'
import { JournalService } from '../services/JournalService'
import { equityTransactionSchema, shareholderSchema } from '../validators/equity.validator'

// Opt in against a migrated local database; all fixtures belong to a uniquely named test company.
const integration = process.env.RUN_EQUITY_DB_TESTS === '1' ? test : test.skip
integration(
  'equity lifecycle, opening allocation, reversal, concurrency and period protection',
  async () => {
    const marker = `Equity verification ${randomUUID()}`
    const [createdCompany] = await db.execute<ResultSetHeader>(
      'INSERT INTO companies(name) VALUES(?)',
      [marker],
    )
    const companyId = createdCompany.insertId
    try {
      const ids: number[] = []
      for (const role of ['maker', 'checker']) {
        const [r] = await db.execute<ResultSetHeader>(
          'INSERT INTO users(company_id,name,email,password) VALUES(?,?,?,?)',
          [companyId, role, `${role}-${randomUUID()}@example.invalid`, 'test-no-login'],
        )
        ids.push(r.insertId)
      }
      const maker = { userId: ids[0]! },
        checker = { userId: ids[1]! }
      const accounts: number[] = []
      for (const [code, name, type, normal] of [
        ['1001', 'Bank', 'asset', 'debit'],
        ['3001', 'Modal', 'equity', 'credit'],
        ['3002', 'Saldo laba', 'equity', 'credit'],
        ['2001', 'Utang dividen', 'liability', 'credit'],
      ]) {
        const [r] = await db.execute<ResultSetHeader>(
          'INSERT INTO accounts(company_id,code,name,account_type,normal_balance) VALUES(?,?,?,?,?)',
          [companyId, code!, name!, type!, normal!],
        )
        accounts.push(r.insertId)
      }
      for (const [key, id] of [
        ['PAID_IN_CAPITAL', accounts[1]],
        ['RETAINED_EARNINGS', accounts[2]],
        ['DIVIDENDS_PAYABLE', accounts[3]],
      ] as const)
        await db.execute(
          'INSERT INTO account_mappings(company_id,mapping_key,account_id) VALUES(?,?,?)',
          [companyId, key, id!],
        )
      for (const month of [10, 11])
        await db.execute(
          'INSERT INTO accounting_periods(company_id,year,month,start_date,end_date) VALUES(?,2026,?,?,?)',
          [companyId, month, `2026-${month}-01`, `2026-${month}-${month === 10 ? '31' : '30'}`],
        )
      const service = new EquityService(),
        journals = new JournalService()
      const holder = await service.createShareholder(
        companyId,
        shareholderSchema.parse({
          code: 'SH-01',
          name: 'Pemegang Saham Satu',
          holding: {
            effective_date: '2026-10-01',
            shares: 100,
            nominal_value: 1000,
            reason: 'Modal awal',
          },
        }),
        maker,
      )
      const payload = equityTransactionSchema.parse({
        request_key: randomUUID(),
        shareholder_id: holder.id,
        transaction_date: '2026-10-03',
        transaction_type: 'contribution',
        amount: 100000,
        counterpart_account_id: accounts[0],
      })
      const deposit = await service.createTransaction(companyId, payload, maker)
      expect(await service.createTransaction(companyId, payload, maker)).toEqual(deposit)
      await expect(
        service.createTransaction(companyId, { ...payload, amount: '200000.00' }, maker),
      ).rejects.toThrow('berbeda')
      await expect(
        service.createTransaction(
          companyId + 1000000,
          { ...payload, request_key: randomUUID() },
          maker,
        ),
      ).rejects.toThrow()
      expect((await service.report(companyId, '2026-10-01', '2026-10-31')).totals.closing).toBe(
        '0.00',
      )
      await journals.submit(deposit.journalId!, companyId, maker)
      await expect(journals.approve(deposit.journalId!, companyId, maker)).rejects.toThrow(
        'tidak boleh',
      )
      await journals.approve(deposit.journalId!, companyId, checker)
      await journals.post(deposit.journalId!, companyId, checker)
      const report = await service.report(companyId, '2026-10-01', '2026-10-31')
      expect(report.totals.closing).toBe('100000.00')
      expect(report.capitalControl.reconciled).toBe(true)
      expect(report.capitalControl.allocationDifference).toBe('0.00')
      expect(report.reconciled).toBe(true)
      await expect(
        service.addHolding(
          companyId,
          holder.id,
          {
            version: 99,
            effective_date: '2026-11-01',
            shares: 90,
            nominal_value: '1000',
            reason: 'Pengalihan saham',
          },
          maker,
        ),
      ).rejects.toThrow('berubah')
      await service.addHolding(
        companyId,
        holder.id,
        {
          version: 1,
          effective_date: '2026-11-01',
          shares: 90,
          nominal_value: '1000',
          reason: 'Pengalihan saham',
        },
        maker,
      )
      expect((await service.shareholders(companyId, '2026-10-31'))[0]!.shares).toBe(100)
      expect((await service.shareholders(companyId, '2026-11-01'))[0]!.shares).toBe(90)
      const old = await journals.create(
        companyId,
        {
          journal_date: '2026-10-01',
          description: 'Modal lama dari migrasi',
          currency: 'IDR',
          exchange_rate: '1',
          lines: [
            { accountId: accounts[0]!, debit: '50000', credit: '0' },
            { accountId: accounts[1]!, debit: '0', credit: '50000' },
          ],
        },
        maker,
      )
      await journals.submit(old.id, companyId, maker)
      await journals.approve(old.id, companyId, checker)
      await journals.post(old.id, companyId, checker)
      const detail = equityTransactionSchema.parse({
        ...payload,
        request_key: randomUUID(),
        transaction_type: 'opening_detail',
        journal_id: old.id,
        transaction_date: '2026-10-01',
        amount: 40000,
        equity_account_id: accounts[1],
      })
      await service.createTransaction(companyId, detail, maker)
      await expect(
        service.createTransaction(
          companyId,
          { ...detail, request_key: randomUUID(), amount: '15000' },
          maker,
        ),
      ).rejects.toThrow('melebihi')
      await service.createTransaction(
        companyId,
        { ...detail, request_key: randomUUID(), amount: '10000' },
        maker,
      )
      expect((await service.report(companyId, '2026-10-01', '2026-10-31')).totals.closing).toBe(
        '150000.00',
      )
      expect((await service.journalOptions(companyId)).length).toBe(0)
      const dividend = await service.createTransaction(
        companyId,
        equityTransactionSchema.parse({
          ...payload,
          request_key: randomUUID(),
          transaction_type: 'dividend',
          amount: 10000,
          counterpart_account_id: undefined,
        }),
        maker,
      )
      await journals.submit(dividend.journalId!, companyId, maker)
      await journals.approve(dividend.journalId!, companyId, checker)
      await journals.post(dividend.journalId!, companyId, checker)
      expect((await service.report(companyId, '2026-10-01', '2026-10-31')).totals.closing).toBe(
        '140000.00',
      )
      await journals.reverse(
        deposit.journalId!,
        companyId,
        '2026-11-01',
        'Koreksi setoran modal',
        checker,
      )
      expect((await service.report(companyId, '2026-10-01', '2026-10-31')).totals.closing).toBe(
        '140000.00',
      )
      const november = await service.report(companyId, '2026-11-01', '2026-11-30')
      expect(november.totals.opening).toBe('140000.00')
      expect(november.totals.closing).toBe('40000.00')
      expect(november.capitalControl.allocatedCapital).toBe('50000.00')
      const draft = await service.createTransaction(
        companyId,
        { ...payload, request_key: randomUUID(), amount: '1000' },
        maker,
      )
      await service.cancel(companyId, draft.id, 'Draft uji dibatalkan', maker)
      await expect(journals.submit(draft.journalId!, companyId, maker)).rejects.toThrow()
      await db.execute(
        "UPDATE accounting_periods SET status='closed' WHERE company_id=? AND month=11",
        [companyId],
      )
      await expect(
        service.createTransaction(
          companyId,
          { ...payload, request_key: randomUUID(), transaction_date: '2026-11-03' },
          maker,
        ),
      ).rejects.toThrow('tidak terbuka')
      console.log('Equity integration: all lifecycle and control checks passed')
    } finally {
      const [ownership] = await db.execute<RowDataPacket[]>(
        'SELECT name FROM companies WHERE id=?',
        [companyId],
      )
      if (ownership[0]?.name !== marker) throw new Error('Refusing to clean an unrelated company')
      await db.execute('DELETE FROM equity_transactions WHERE company_id=?', [companyId])
      await db.execute(
        'DELETE jl FROM journal_lines jl JOIN journals j ON j.id=jl.journal_id WHERE j.company_id=?',
        [companyId],
      )
      await db.execute(
        'UPDATE journals SET original_journal_id=NULL,reversal_journal_id=NULL WHERE company_id=?',
        [companyId],
      )
      await db.execute('DELETE FROM journals WHERE company_id=?', [companyId])
      await db.execute(
        'DELETE h FROM shareholder_holdings h JOIN shareholders s ON s.id=h.shareholder_id WHERE s.company_id=?',
        [companyId],
      )
      for (const table of [
        'shareholders',
        'account_mappings',
        'operation_requests',
        'audit_logs',
        'number_sequences',
        'accounting_periods',
        'accounts',
        'users',
      ])
        await db.execute(`DELETE FROM ${table} WHERE company_id=?`, [companyId])
      await db.execute('DELETE FROM companies WHERE id=? AND name=?', [companyId, marker])
      await db.end()
    }
  },
  30000,
)
