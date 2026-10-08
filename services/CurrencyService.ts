import { BusinessValidationService } from './BusinessValidationService'
import { accountingPolicy, validateFxPolicy } from './AccountingPolicyService'
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import type { z } from 'zod'
import { db, transaction } from '../config/database'
import type { QueryExecutor } from '../types/database'
import {
  addDecimal,
  subtractDecimal,
  compareDecimal,
  multiplyDecimal,
  divideDecimal,
} from '../utils/decimal'
import { ValidationError, ConflictError } from '../utils/AppError'
import { PostingService, type PostingContext, type JournalLineInput } from './PostingService'
import { AccountMappingService } from './AccountMappingService'
import { AuditService } from './AuditService'
import { idempotentOperation } from './IdempotentOperation'
import type {
  currencyRateSchema,
  bankTransferSchema,
  bankRevalueSchema,
} from '../validators/currency.validator'

export function fxLine(
  difference: string,
  asset: boolean,
  gain: number,
  loss: number,
): JournalLineInput[] {
  if (compareDecimal(difference, '0') === 0) return []
  const isGain = compareDecimal(difference, '0') > 0 === asset
  const amount = compareDecimal(difference, '0') < 0 ? subtractDecimal('0', difference) : difference
  return [
    {
      accountId: isGain ? gain : loss,
      debit: isGain ? '0' : amount,
      credit: isGain ? amount : '0',
    },
  ]
}
export class CurrencyService {
  async options(companyId:number){
    const baseCurrency = await this.base(db,companyId)
    const [rows] = await db.execute<RowDataPacket[]>(
      'SELECT code,name FROM currencies WHERE is_active=TRUE OR code=? ORDER BY code', [baseCurrency],
    )
    const currencies = rows.map(row => ({code:String(row.code),name:String(row.name)}))
    // The company's bookkeeping currency must remain usable even on older databases.
    if (!currencies.some(currency => currency.code === baseCurrency))
      currencies.unshift({code:baseCurrency,name:baseCurrency === 'IDR' ? 'Indonesian Rupiah' : baseCurrency})
    return {baseCurrency,currencies}
  }
  async quote(companyId:number,currency:string,date:string){
    const baseCurrency=await this.base(db,companyId)
    if(currency===baseCurrency)return {currency,baseCurrency,rate:'1',date,source:'Mata uang pembukuan'}
    const [rates]=await db.execute<RowDataPacket[]>('SELECT exchange_rate,rate_date,source FROM exchange_rates WHERE company_id=? AND from_currency=? AND to_currency=? AND rate_date<=? ORDER BY rate_date DESC LIMIT 1',[companyId,currency,baseCurrency,date])
    return {currency,baseCurrency,rate:rates[0]?.exchange_rate??null,date:rates[0]?.rate_date??null,source:rates[0]?.source??null}
  }
  async baseCurrency(companyId:number){return {baseCurrency:await this.base(db,companyId)}}
  async overview(companyId: number, date = new Date().toISOString().slice(0, 10)) {
    const [company] = await db.execute<RowDataPacket[]>(
      'SELECT base_currency FROM companies WHERE id=?',
      [companyId],
    )
    const [currencies] = await db.query<RowDataPacket[]>(
      'SELECT code,name FROM currencies WHERE is_active=TRUE ORDER BY code',
    )
    const [rates] = await db.execute<RowDataPacket[]>(
      'SELECT * FROM exchange_rates WHERE company_id=? ORDER BY rate_date DESC,id DESC LIMIT 100',
      [companyId],
    )
    const [banks] = await db.execute<RowDataPacket[]>(
      'SELECT b.*,a.code account_code,a.name account_name FROM bank_accounts b JOIN accounts a ON a.id=b.gl_account_id WHERE b.company_id=? AND b.deleted_at IS NULL AND b.is_active=TRUE ORDER BY b.code',
      [companyId],
    )
    const [operations] = await db.execute<RowDataPacket[]>(
      `SELECT o.*,j.journal_number,j.status journal_status,f.code from_bank_code,t.code to_bank_code,f.currency from_currency,t.currency to_currency FROM currency_bank_operations o JOIN journals j ON j.id=o.journal_id JOIN bank_accounts f ON f.id=o.from_bank_id LEFT JOIN bank_accounts t ON t.id=o.to_bank_id WHERE o.company_id=? ORDER BY o.operation_date DESC,o.id DESC LIMIT 100`,
      [companyId],
    )
    const positions = []
    for (const bank of banks) {
      try {
        const position = await this.position(db, companyId, bank, date)
        positions.push({
          ...bank,
          native_balance: position.native,
          base_balance: position.base,
          position_error: null,
        })
      } catch (e) {
        positions.push({
          ...bank,
          native_balance: null,
          base_balance: null,
          position_error: e instanceof Error ? e.message : String(e),
        })
      }
    }
    return {
      baseCurrency: company[0]!.base_currency,
      currencies,
      rates,
      banks: positions,
      operations,
      date,
    }
  }
  async saveRate(
    companyId: number,
    input: z.infer<typeof currencyRateSchema>,
    context: PostingContext,
  ) {
    return transaction(async (c) => {
      const base = await this.base(c, companyId)
      if (input.currency === base && input.rate !== 1)
        throw new ValidationError('Kurs mata uang dasar harus 1')
      const [known] = await c.execute<RowDataPacket[]>(
        'SELECT code FROM currencies WHERE code=? AND is_active=TRUE',
        [input.currency],
      )
      if (!known[0]) throw new ValidationError('Mata uang belum tersedia di master')
      await c.execute(
        'INSERT INTO company_currencies(company_id,currency_code,is_base,is_active) VALUES(?,?,?,TRUE) ON DUPLICATE KEY UPDATE is_active=TRUE',
        [companyId, input.currency, input.currency === base],
      )
      await c.execute(
        `INSERT INTO exchange_rates(company_id,rate_date,from_currency,to_currency,exchange_rate,source,created_by) VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE exchange_rate=VALUES(exchange_rate),source=VALUES(source),created_by=VALUES(created_by)`,
        [companyId, input.date, input.currency, base, input.rate, input.source, context.userId],
      )
      await this.log(c, companyId, context, 'update', 0, input)
      return { saved: true }
    })
  }
  private async base(c: QueryExecutor, companyId: number) {
    const [rows] = await c.execute<RowDataPacket[]>(
      'SELECT base_currency FROM companies WHERE id=?',
      [companyId],
    )
    return String(rows[0]!.base_currency)
  }
  private async bank(c: QueryExecutor, companyId: number, id: number) {
    const [rows] = await c.execute<RowDataPacket[]>(
      'SELECT * FROM bank_accounts WHERE company_id=? AND id=? AND is_active=TRUE AND deleted_at IS NULL FOR UPDATE',
      [companyId, id],
    )
    if (!rows[0]) throw new ValidationError('Rekening aktif tidak ditemukan')
    const bank = rows[0]
    const [shared] = await c.execute<RowDataPacket[]>(
      'SELECT id FROM bank_accounts WHERE company_id=? AND gl_account_id=? AND deleted_at IS NULL',
      [companyId, bank.gl_account_id],
    )
    if (shared.length !== 1)
      throw new ValidationError(
        'Setiap rekening untuk transfer/kurs harus memiliki akun GL tersendiri',
      )
    return bank
  }
  async cashPosition(c: QueryExecutor, companyId: number, id: number, date: string) {
    const bank = await this.bank(c, companyId, id)
    await this.ensureChronology(c, companyId, bank, date)
    return this.position(c, companyId, bank, date)
  }
  async ensureChronology(c: QueryExecutor, companyId: number, bank: RowDataPacket, date: string) {
    if (bank.currency === (await this.base(c, companyId))) return
    const [later] = await c.execute<RowDataPacket[]>(
      `SELECT j.journal_number FROM journals j JOIN journal_lines l ON l.journal_id=j.id WHERE j.company_id=? AND l.account_id=? AND j.status IN('posted','reversed') AND j.journal_date>? LIMIT 1`,
      [companyId, bank.gl_account_id, date],
    )
    if (later.length)
      throw new ConflictError(
        'Ada transaksi valas sesudah tanggal ini. Gunakan tanggal setelah transaksi terakhir agar nilai tercatat tetap konsisten.',
      )
  }
  async position(c: QueryExecutor, companyId: number, bank: RowDataPacket, date: string) {
    const [book] = await c.execute<RowDataPacket[]>(
      `SELECT COALESCE(SUM(l.debit-l.credit),0) balance FROM journals j JOIN journal_lines l ON l.journal_id=j.id WHERE j.company_id=? AND j.journal_date<=? AND j.status IN ('posted','reversed') AND l.account_id=?`,
      [companyId, date, bank.gl_account_id],
    )
    const baseBalance = String(book[0]!.balance)
    if (bank.currency === (await this.base(c, companyId)))
      return { native: baseBalance, base: baseBalance }
    // Foreign cash is reconstructed from recorded native movements, never by dividing a GL balance by today's rate.
    const [native] = await c.execute<RowDataPacket[]>(
      `SELECT COALESCE(SUM(l.currency_debit-l.currency_credit),0) balance FROM journals j JOIN journal_lines l ON l.journal_id=j.id WHERE j.company_id=? AND l.account_id=? AND j.journal_date<=? AND j.status IN('posted','reversed') AND l.currency_code=?`,
      [companyId, bank.gl_account_id, date, bank.currency],
    )
    const amount = String(native[0]!.balance)
    if (compareDecimal(amount, '0') === 0 && compareDecimal(baseBalance, '0') !== 0)
      throw new ConflictError(
        'Saldo valas belum memiliki rincian mata uang asal. Migrasikan saldo melalui transaksi valas sebelum diproses.',
      )
    // Do not accept manual GL postings to a foreign bank: they carry no auditable native cash movement.
    const [unknown] = await c.execute<RowDataPacket[]>(
      `SELECT COUNT(*) n FROM journals j JOIN journal_lines l ON l.journal_id=j.id WHERE j.company_id=? AND j.journal_date<=? AND j.status='posted' AND l.account_id=? AND (l.currency_code IS NULL OR l.currency_code<>?)`,
      [companyId, date, bank.gl_account_id, bank.currency],
    )
    if (Number(unknown[0]!.n))
      throw new ConflictError(
        'Ada jurnal langsung pada rekening valas tanpa rincian valuta. Cocokkan atau migrasikan sumber transaksi dahulu.',
      )
    return { native: amount, base: baseBalance }
  }
  reverse(
    companyId: number,
    id: number,
    input: { request_key: string; date: string; reason: string },
    context: PostingContext,
  ) {
    return idempotentOperation(
      companyId,
      input.request_key,
      'currency-reverse',
      { id, ...input },
      async (c) => {
        const [rows] = await c.execute<RowDataPacket[]>(
          'SELECT o.*,j.status FROM currency_bank_operations o JOIN journals j ON j.id=o.journal_id WHERE o.company_id=? AND o.id=? FOR UPDATE',
          [companyId, id],
        )
        const op = rows[0]
        if (!op || op.status !== 'posted')
          throw new ConflictError('Transaksi valas tidak ditemukan atau sudah dibalik')
        const originalDate =
          op.operation_date instanceof Date
            ? op.operation_date.toISOString().slice(0, 10)
            : String(op.operation_date).slice(0, 10)
        const [matched] = await c.execute<RowDataPacket[]>(
          `SELECT m.id FROM bank_reconciliation_matches m JOIN journal_lines l ON l.id=m.journal_line_id WHERE l.journal_id=? AND m.status='confirmed' LIMIT 1`,
          [op.journal_id],
        )
        if (matched.length)
          throw new ConflictError('Lepaskan rekonsiliasi bank sebelum membalik transfer/revaluasi')
        if (input.date < originalDate)
          throw new ValidationError('Tanggal pembalikan tidak boleh sebelum transaksi asli')
        const ids = [
          Number(op.from_bank_id),
          ...(op.to_bank_id ? [Number(op.to_bank_id)] : []),
        ].sort((a, b) => a - b)
        const banks = []
        for (const bankId of ids) banks.push(await this.bank(c, companyId, bankId))
        for (const bank of banks) {
          const [later] = await c.execute<RowDataPacket[]>(
            `SELECT j.id FROM journals j JOIN journal_lines l ON l.journal_id=j.id WHERE j.company_id=? AND l.account_id=? AND j.status IN('posted','reversed') AND (j.journal_date>? OR (j.journal_date=? AND j.id>?)) LIMIT 1`,
            [companyId, bank.gl_account_id, originalDate, originalDate, op.journal_id],
          )
          if (later.length)
            throw new ConflictError(
              'Balikkan transaksi rekening yang lebih baru dahulu agar nilai valuta tetap konsisten',
            )
        }
        const journalId = await new PostingService().reversePostedJournal(c, {
          companyId,
          journalId: Number(op.journal_id),
          date: input.date,
          reason: input.reason,
          context,
        })
        if (op.operation_type === 'transfer') {
          await c.execute('UPDATE bank_accounts SET current_balance=current_balance+? WHERE id=?', [
            addDecimal([op.from_amount, op.fee_amount]),
            op.from_bank_id,
          ])
          await c.execute('UPDATE bank_accounts SET current_balance=current_balance-? WHERE id=?', [
            op.to_amount,
            op.to_bank_id,
          ])
        }
        await this.log(c, companyId, context, 'reverse', id, { reason: input.reason, journalId })
        return { journalId }
      },
    )
  }
  transfer(companyId: number, input: z.infer<typeof bankTransferSchema>, context: PostingContext) {
    return idempotentOperation(
      companyId,
      input.request_key,
      'currency-transfer',
      input,
      async (c) => {
        // Stable lock ordering prevents opposite-direction transfers deadlocking.
        const banks = new Map<number, RowDataPacket>()
        for (const id of [input.from_bank_id, input.to_bank_id].sort((a, b) => a - b))
          banks.set(id, await this.bank(c, companyId, id))
        const from = banks.get(input.from_bank_id)!,
          to = banks.get(input.to_bank_id)!,
          base = await this.base(c, companyId)
        await this.ensureChronology(c, companyId, from, input.date)
        await this.ensureChronology(c, companyId, to, input.date)
        const position = await this.position(c, companyId, from, input.date)
        await this.position(c, companyId, to, input.date)
        const out = addDecimal([input.from_amount, input.fee_amount])
        if (compareDecimal(position.native, out) < 0)
          throw new ConflictError('Saldo rekening sumber tidak cukup pada tanggal transaksi')
        await validateFxPolicy(c,companyId,String(to.currency),input.date,input.target_rate)
        if (to.currency === base && input.target_rate !== 1)
          throw new ValidationError('Kurs rekening mata uang dasar harus 1')
        if (
          from.currency === to.currency &&
          compareDecimal(input.from_amount, input.to_amount) !== 0
        )
          throw new ValidationError(
            'Transfer mata uang sama harus memiliki nominal pokok yang sama; catat biaya terpisah',
          )
        const fromBase =
          from.currency === base
            ? input.from_amount
            : divideDecimal(
                multiplyDecimal(position.base, 2, input.from_amount, 2),
                2,
                position.native,
                2,
              )
        const feeBase =
          from.currency === base
            ? input.fee_amount
            : divideDecimal(
                multiplyDecimal(position.base, 2, input.fee_amount, 2),
                2,
                position.native,
                2,
              )
        const toBase =
          from.currency === to.currency
            ? fromBase
            : multiplyDecimal(input.to_amount, 2, String(input.target_rate), 8)
        const mapping = new AccountMappingService(),
          diff = subtractDecimal(toBase, fromBase)
        if (from.currency === base && to.currency !== base && compareDecimal(diff, 0) !== 0)
          throw new ValidationError(
            'Kurs pembelian valuta harus sesuai pokok mata uang dasar dibagi valuta yang diterima. Gunakan revaluasi terpisah untuk kurs penutupan.',
          )
        const lines: JournalLineInput[] = [
          {
            accountId: Number(to.gl_account_id),
            debit: toBase,
            credit: '0',
            currencyDebit: input.to_amount,
            currencyCredit: '0',
            currencyCode: to.currency,
            exchangeRate: divideDecimal(toBase, 2, input.to_amount, 2, 8),
          },
          {
            accountId: Number(from.gl_account_id),
            debit: '0',
            credit: addDecimal([fromBase, feeBase]),
            currencyDebit: '0',
            currencyCredit: out,
            currencyCode: from.currency,
            exchangeRate: divideDecimal(addDecimal([fromBase, feeBase]), 2, out, 2, 8),
          },
        ]
        if (compareDecimal(feeBase, '0') > 0)
          lines.push({
            accountId: await mapping.resolve(c, companyId, 'BANK_FEE'),
            debit: feeBase,
            credit: '0',
          })
        if (compareDecimal(diff, '0') !== 0) {
          const gain = await mapping.resolve(c, companyId, 'FX_GAIN'),
            loss = await mapping.resolve(c, companyId, 'FX_LOSS')
          lines.push(...fxLine(diff, true, gain, loss))
        }
        const [row] = await c.execute<ResultSetHeader>(
          `INSERT INTO currency_bank_operations(company_id,operation_type,operation_date,from_bank_id,to_bank_id,from_amount,to_amount,from_base,to_base,exchange_rate,fee_amount,reference,journal_id,created_by) VALUES(?,'transfer',?,?,?,?,?,?,?,?,?,?,NULL,?)`,
          [
            companyId,
            input.date,
            from.id,
            to.id,
            input.from_amount,
            input.to_amount,
            fromBase,
            toBase,
            input.target_rate,
            input.fee_amount,
            input.reference,
            context.userId,
          ],
        )
        const journalId = await new PostingService().createPostedJournal(c, {
          companyId,
          sourceType: 'currency_transfer',
          sourceId: row.insertId,
          date: input.date,
          reference: input.reference,
          description: `Transfer ${from.code} → ${to.code}`,
          currency: base,
          lines,
          context,
        })
        await c.execute('UPDATE currency_bank_operations SET journal_id=? WHERE id=?', [
          journalId,
          row.insertId,
        ])
        await c.execute('UPDATE bank_accounts SET current_balance=current_balance-? WHERE id=?', [
          out,
          from.id,
        ])
        await c.execute('UPDATE bank_accounts SET current_balance=current_balance+? WHERE id=?', [
          input.to_amount,
          to.id,
        ])
        await this.log(c, companyId, context, 'post', row.insertId, {
          ...input,
          fromBase,
          toBase,
          difference: diff,
          journalId,
        })
        return { id: row.insertId, journalId, fromBase, toBase, fx: diff }
      },
    )
  }
  revalue(
    companyId: number,
    input: z.infer<typeof bankRevalueSchema>,
    context: PostingContext,
    preview = false,
  ) {
    const work = async (c: QueryExecutor) => {
      const bank = await this.bank(c, companyId, input.bank_id),
        base = await this.base(c, companyId)
      await this.ensureChronology(c, companyId, bank, input.date)
      if (bank.currency === base)
        throw new ValidationError('Revaluasi hanya untuk rekening mata uang asing')
      await validateFxPolicy(c,companyId,String(bank.currency),input.date,input.rate)
      const position = await this.position(c, companyId, bank, input.date),
        target = multiplyDecimal(position.native, 2, String(input.rate), 8),
        difference = subtractDecimal(target, position.base)
      const result = {
        native: position.native,
        carryingBase: position.base,
        targetBase: target,
        difference,
        currency: bank.currency,
      }
      if (preview) return result
      if (compareDecimal(difference, '0') === 0)
        throw new ConflictError('Tidak ada selisih yang perlu dijurnal')
      const policy=await accountingPolicy(c,companyId)
      const mapping = new AccountMappingService(),
        gain = Number(policy['accounting.fx_unrealized_gain_account_id']||0)||await mapping.resolve(c, companyId, 'FX_GAIN'),
        loss = Number(policy['accounting.fx_unrealized_loss_account_id']||0)||await mapping.resolve(c, companyId, 'FX_LOSS')
      for(const id of [gain,loss])await new BusinessValidationService().ensureActiveReference(c,{companyId,table:'accounts',id,label:'Akun revaluasi kurs',postingOnly:true})
      const amount =
        compareDecimal(difference, '0') < 0 ? subtractDecimal('0', difference) : difference
      const [created] = await c.execute<ResultSetHeader>(
        `INSERT INTO currency_bank_operations(company_id,operation_type,operation_date,from_bank_id,from_base,to_base,exchange_rate,reference,journal_id,created_by) VALUES(?,'revaluation',?,?,?,?,?,?,NULL,?)`,
        [
          companyId,
          input.date,
          bank.id,
          position.base,
          target,
          input.rate,
          input.reference,
          context.userId,
        ],
      )
      const journalId = await new PostingService().createPostedJournal(c, {
        companyId,
        sourceType: 'currency_revaluation',
        sourceId: created.insertId,
        date: input.date,
        reference: input.reference,
        description: `Revaluasi ${bank.code} ${bank.currency}`,
        currency: base,
        context,
        lines: [
          {
            accountId: Number(bank.gl_account_id),
            debit: compareDecimal(difference, '0') > 0 ? amount : '0',
            credit: compareDecimal(difference, '0') < 0 ? amount : '0',
            currencyDebit: '0',
            currencyCredit: '0',
            currencyCode: bank.currency,
            exchangeRate: input.rate,
          },
          ...fxLine(difference, true, gain, loss),
        ],
      })
      await c.execute('UPDATE currency_bank_operations SET journal_id=? WHERE id=?', [
        journalId,
        created.insertId,
      ])
      await this.log(c, companyId, context, 'post', created.insertId, { ...result, journalId })
      return { ...result, journalId }
    }
    return preview
      ? transaction(work)
      : idempotentOperation(companyId, input.request_key, 'currency-revaluation', input, work)
  }
  private log(
    c: QueryExecutor,
    companyId: number,
    context: PostingContext,
    action: string,
    id: number,
    value: unknown,
  ) {
    return new AuditService().log(c, {
      companyId,
      userId: context.userId,
      module: 'currency',
      action,
      recordType: 'currency_bank_operation',
      recordId: id,
      newValue: value,
      requestId: context.requestId,
      ip: context.ip,
    })
  }
}
