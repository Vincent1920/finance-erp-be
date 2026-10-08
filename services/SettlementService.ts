import { validateFxPolicy } from './AccountingPolicyService'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { db, transaction } from '../config/database'
import type { QueryExecutor } from '../types/database'
import { ConflictError, NotFoundError, ValidationError } from '../utils/AppError'
import {
  addDecimal,
  subtractDecimal,
  compareDecimal,
  multiplyDecimal,
  percentageOf,
  divideDecimal,
} from '../utils/decimal'
import { PostingService, type PostingContext } from './PostingService'
import { NumberSequenceService } from './NumberSequenceService'
import { AuditService } from './AuditService'
import { BusinessValidationService } from './BusinessValidationService'
import { idempotentOperation } from './IdempotentOperation'
import { AccountMappingService } from './AccountMappingService'
import { fxLine, CurrencyService } from './CurrencyService'
import type { SettlementInput } from '../validators/operations.validator'
import type { ReversalInput } from '../validators/operations.validator'
const dateOnly = (value: unknown) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)

export function calculateSettlementAmounts(
  sales: boolean,
  grossAmount: string,
  requestedFee: string,
  feeRate: number,
  exchangeRate: string,
) {
  const feeAmount = feeRate > 0 ? percentageOf(grossAmount, feeRate) : requestedFee
  if (sales && compareDecimal(feeAmount, grossAmount) >= 0)
    throw new ValidationError('Biaya administrasi harus lebih kecil dari jumlah pelunasan')
  const bankAmount = sales
    ? subtractDecimal(grossAmount, feeAmount)
    : addDecimal([grossAmount, feeAmount])
  return {
    feeAmount,
    bankAmount,
    baseGross: multiplyDecimal(grossAmount, 2, exchangeRate, 8),
    baseFee: multiplyDecimal(feeAmount, 2, exchangeRate, 8),
    baseBank: multiplyDecimal(bankAmount, 2, exchangeRate, 8),
  }
}

export class SettlementService {
  async list(
    companyId: number,
    sales: boolean,
    filters: {
      invoiceId?: number
      dateFrom?: string
      dateTo?: string
      status?: string
      search?: string
    } = {},
  ) {
    const payment = sales ? 'customer' : 'supplier',
      invoice = sales ? 'sales' : 'purchase'
    const clauses = ['p.company_id=?', 'p.deleted_at IS NULL']
    const params: Array<string | number> = [companyId]
    if (filters.invoiceId) {
      clauses.push(`a.${invoice}_invoice_id=?`)
      params.push(filters.invoiceId)
    }
    if (filters.dateFrom) {
      clauses.push('p.payment_date>=?')
      params.push(filters.dateFrom)
    }
    if (filters.dateTo) {
      clauses.push('p.payment_date<=?')
      params.push(filters.dateTo)
    }
    if (filters.status) {
      clauses.push('p.status=?')
      params.push(filters.status)
    }
    if (filters.search) {
      clauses.push(
        `(p.payment_number LIKE ? OR p.reference LIKE ? OR i.invoice_number LIKE ? OR x.name LIKE ? OR x.code LIKE ?)`,
      )
      const search = `%${filters.search}%`
      params.push(search, search, search, search, search)
    }
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT p.id,p.payment_number,p.payment_date,p.amount,p.currency,COALESCE(p.bank_currency,p.currency) bank_currency,p.status,p.journal_id,
        p.reversal_journal_id,p.reference,p.payment_method,p.cash_account_id,p.bank_account_id,
        p.processing_fee_rate,p.processing_fee_amount,p.bank_amount,p.processing_fee_account_id,p.exchange_rate,p.fx_amount,p.base_bank_amount,
        ROW_NUMBER() OVER(PARTITION BY p.id ORDER BY a.id) AS payment_row_number,
        COUNT(*) OVER(PARTITION BY p.id) AS payment_invoice_count,
        a.amount AS allocated_amount,a.${invoice}_invoice_id AS invoice_id,i.invoice_number,
        x.id AS party_id,x.code AS party_code,x.name AS party_name,ac.code AS cash_account_code,
        ac.name AS cash_account_name,b.bank_name,b.account_number,fc.code AS fee_account_code,fc.name AS fee_account_name
       FROM ${payment}_payments p
       INNER JOIN ${payment}_payment_allocations a ON a.${payment}_payment_id=p.id
       INNER JOIN ${invoice}_invoices i ON i.id=a.${invoice}_invoice_id AND i.company_id=p.company_id
       INNER JOIN ${payment}s x ON x.id=p.${payment}_id AND x.company_id=p.company_id
       INNER JOIN accounts ac ON ac.id=p.cash_account_id
       LEFT JOIN accounts fc ON fc.id=p.processing_fee_account_id
       LEFT JOIN bank_accounts b ON b.id=p.bank_account_id
       WHERE ${clauses.join(' AND ')} ORDER BY p.payment_date DESC,p.id DESC LIMIT 500`,
      params,
    )
    return rows
  }
  post(companyId: number, sales: boolean, input: SettlementInput, context: PostingContext) {
    return idempotentOperation(
      companyId,
      input.request_key,
      sales ? 'receivable-settlement' : 'payable-settlement',
      input,
      async (connection) => {
        const type = sales ? 'sales' : 'purchase',
          party = sales ? 'customer' : 'supplier'
        const requested = (
          input.allocations?.length
            ? input.allocations
            : [{ invoice_id: input.invoice_id!, amount: input.amount! }]
        )
          .slice()
          .sort((a, b) => a.invoice_id - b.invoice_id)
        const invoiceIds = requested.map((item) => item.invoice_id)
        const placeholders = invoiceIds.map(() => '?').join(',')
        const [invoices] = await connection.execute<RowDataPacket[]>(
          `SELECT i.* FROM ${type}_invoices i INNER JOIN ${party}s p ON p.id=i.${party}_id AND p.company_id=i.company_id WHERE i.id IN (${placeholders}) AND i.company_id=? ORDER BY i.id FOR UPDATE`,
          [...invoiceIds, companyId],
        )
        if (invoices.length !== requested.length)
          throw new NotFoundError('Satu atau beberapa invoice tidak ditemukan')
        const firstInvoice = invoices[0]!
        if (
          invoices.some(
            (invoice) => Number(invoice[`${party}_id`]) !== Number(firstInvoice[`${party}_id`]),
          )
        )
          throw new ValidationError(
            `Semua invoice harus milik ${sales ? 'pelanggan' : 'pemasok'} yang sama`,
          )
        if (invoices.some((invoice) => invoice.currency !== firstInvoice.currency))
          throw new ValidationError(
            'Semua invoice dalam satu pelunasan harus memakai mata uang yang sama',
          )
        const [company] = await connection.execute<RowDataPacket[]>(
          'SELECT base_currency FROM companies WHERE id=?',
          [companyId],
        )
        const baseCurrency = String(company[0]!.base_currency)
        const foreign = firstInvoice.currency !== baseCurrency
        if (foreign && (!input.bank_account_id || !input.exchange_rate))
          throw new ValidationError(
            'Pelunasan valas wajib memilih rekening dan kurs tanggal pelunasan',
          )
        if (!foreign && input.exchange_rate && input.exchange_rate !== 1)
          throw new ValidationError('Kurs mata uang dasar harus 1')
        const paymentRate = foreign ? String(input.exchange_rate) : '1'
        await validateFxPolicy(connection,companyId,String(firstInvoice.currency),input.date,paymentRate)
        let bankCurrency=String(firstInvoice.currency)
        const invoiceById = new Map(invoices.map((invoice) => [Number(invoice.id), invoice]))
        const allocations: Array<{
          invoiceId: number
          invoiceNumber: string
          amount: string
          base: string
          accountId: number
        }> = []
        for (const item of requested) {
          const invoice = invoiceById.get(item.invoice_id)!
          if (!['posted', 'partially_paid'].includes(invoice.status))
            throw new ConflictError(
              `Invoice ${invoice.invoice_number} harus posted dan belum lunas`,
            )
          if (input.date < dateOnly(invoice.invoice_date))
            throw new ValidationError(
              `Tanggal pelunasan tidak boleh sebelum invoice ${invoice.invoice_number}`,
            )
          if (!invoice.control_account_id)
            throw new ValidationError(
              'Akun kontrol historis invoice belum dapat ditentukan. Periksa jurnal asli sebelum melunasi.',
            )
          const [paid] = await connection.execute<RowDataPacket[]>(
            `SELECT COALESCE(SUM(a.amount),0) amount,COALESCE(SUM(a.base_amount),0) base_amount FROM ${party}_payment_allocations a INNER JOIN ${party}_payments p ON p.id=a.${party}_payment_id WHERE a.${type}_invoice_id=? AND p.company_id=? AND p.status='posted'`,
            [item.invoice_id, companyId],
          )
          const [returned] = await connection.execute<RowDataPacket[]>(
            `SELECT COALESCE(SUM(grand_total),0) amount,COALESCE(SUM(base_grand_total),0) base_amount FROM ${type}_returns WHERE ${type}_invoice_id=? AND company_id=? AND status='posted'`,
            [item.invoice_id, companyId],
          )
          const [credits]=await connection.execute<RowDataPacket[]>(`SELECT COALESCE(SUM(ca.amount),0) amount,COALESCE(SUM(ca.base_amount),0) base_amount FROM party_credit_applications ca JOIN party_credits pc ON pc.id=ca.party_credit_id AND pc.company_id=ca.company_id WHERE ca.company_id=? AND ca.target_invoice_id=? AND ca.status='posted' AND ca.application_type='invoice' AND pc.party_type=?`,[companyId,item.invoice_id,party])
          const outstanding = subtractDecimal(
            subtractDecimal(String(invoice.grand_total), String(paid[0]!.amount)),
            addDecimal([String(returned[0]!.amount),String(credits[0]!.amount)]),
          )
          if (compareDecimal(item.amount, outstanding) > 0)
            throw new ConflictError(
              `Pelunasan ${invoice.invoice_number} melebihi sisa invoice ${outstanding}`,
            )
          const remainingBase=subtractDecimal(subtractDecimal(String(invoice.base_grand_total),String(paid[0]!.base_amount)),addDecimal([String(returned[0]!.base_amount),String(credits[0]!.base_amount)]))
          const allocationBase=compareDecimal(item.amount,outstanding)===0?remainingBase:multiplyDecimal(item.amount,2,String(invoice.exchange_rate),8)
          if(compareDecimal(allocationBase,remainingBase)>0)throw new ConflictError('Nilai pelunasan melampaui saldo pembukuan invoice')
          allocations.push({
            accountId: Number(invoice.control_account_id),
            invoiceId: item.invoice_id,
            invoiceNumber: String(invoice.invoice_number),
            amount: item.amount,
            base: allocationBase,
          })
        }
        const amount = addDecimal(allocations.map((item) => item.amount))
        const mappings = new AccountMappingService()
        const calculatedAmounts = calculateSettlementAmounts(
          sales,
          amount,
          input.processing_fee_amount ?? '0.00',
          input.processing_fee_rate ?? 0,
          paymentRate,
        )
        const base = addDecimal(allocations.map((item) => item.base))
        const amounts = {
          ...calculatedAmounts,
          baseGross: base,
          baseBank: calculatedAmounts.baseBank,
        }
        await new BusinessValidationService().ensureActiveReference(connection, {
          table: 'accounts',
          id: input.cash_account_id,
          companyId,
          label: 'Akun kas/bank',
          postingOnly: true,
        })
        if (allocations.some((allocation) => input.cash_account_id === allocation.accountId))
          throw new ValidationError('Akun kas/bank harus berbeda dari akun piutang/utang')
        if (compareDecimal(amounts.feeAmount, '0') > 0) {
          input.processing_fee_account_id = await mappings.resolve(
            connection,
            companyId,
            'BANK_FEE',
            input.processing_fee_account_id,
          )
          await new BusinessValidationService().ensureActiveReference(connection, {
            table: 'accounts',
            id: input.processing_fee_account_id,
            companyId,
            label: 'Akun beban biaya administrasi',
            postingOnly: true,
          })
          if (
            [input.cash_account_id, ...allocations.map((a) => a.accountId)].includes(
              input.processing_fee_account_id,
            )
          )
            throw new ValidationError(
              'Akun biaya administrasi harus berbeda dari akun bank dan akun kontrol',
            )
        }
        if (input.bank_account_id) {
          const [banks] = await connection.execute<RowDataPacket[]>(
            'SELECT * FROM bank_accounts WHERE id=? AND company_id=? AND is_active=TRUE AND deleted_at IS NULL',
            [input.bank_account_id, companyId],
          )
          if (
            !banks[0] ||
            Number(banks[0].gl_account_id) !== input.cash_account_id ||
            ![firstInvoice.currency,baseCurrency].includes(banks[0].currency)
          )
            throw new ValidationError('Rekening, akun GL, dan mata uang invoice tidak cocok')
          bankCurrency=String(banks[0].currency)
          if(foreign && bankCurrency===baseCurrency){
            amounts.bankAmount=amounts.baseBank
          }
          if (foreign && bankCurrency !== baseCurrency) {
            const position = await new CurrencyService().cashPosition(
              connection,
              companyId,
              input.bank_account_id,
              input.date,
            )
            if (!sales) {
              if (compareDecimal(position.native, amounts.bankAmount) < 0)
                throw new ConflictError('Saldo valas tidak cukup pada tanggal pelunasan')
              amounts.baseBank = divideDecimal(
                multiplyDecimal(position.base, 2, amounts.bankAmount, 2),
                2,
                position.native,
                2,
              )
              amounts.baseFee = divideDecimal(
                multiplyDecimal(position.base, 2, amounts.feeAmount, 2),
                2,
                position.native,
                2,
              )
            }
          }
        }
        const number = await new NumberSequenceService().next(
          connection,
          companyId,
          `${party}_payment`,
          input.date,
        )
        const [result] = await connection.execute<ResultSetHeader>(
          `INSERT INTO ${party}_payments(company_id,payment_number,payment_date,${party}_id,bank_account_id,cash_account_id,processing_fee_account_id,payment_method,reference,currency,exchange_rate,amount,base_amount,processing_fee_rate,processing_fee_amount,base_processing_fee_amount,bank_amount,base_bank_amount,unallocated_amount,status,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'draft',?)`,
          [
            companyId,
            number,
            input.date,
            firstInvoice[`${party}_id`],
            input.bank_account_id ?? null,
            input.cash_account_id,
            input.processing_fee_account_id ?? null,
            input.payment_method ?? (input.bank_account_id ? 'bank_transfer' : 'cash'),
            input.reference,
            firstInvoice.currency,
            paymentRate,
            amount,
            calculatedAmounts.baseGross,
            input.processing_fee_rate ?? 0,
            amounts.feeAmount,
            amounts.baseFee,
            amounts.bankAmount,
            amounts.baseBank,
            context.userId,
          ],
        )
        const fxDifference = subtractDecimal(
          sales
            ? addDecimal([amounts.baseBank, amounts.baseFee])
            : subtractDecimal(amounts.baseBank, amounts.baseFee),
          base,
        )
        const fxLines =
          compareDecimal(fxDifference, '0') === 0
            ? []
            : fxLine(
                fxDifference,
                sales,
                await mappings.resolve(connection, companyId, 'FX_GAIN'),
                await mappings.resolve(connection, companyId, 'FX_LOSS'),
              )
        const journalId = await new PostingService().createPostedJournal(connection, {
          companyId,
          sourceType: `${party}_payment`,
          sourceId: result.insertId,
          date: input.date,
          reference: number,
          description:
            allocations.length === 1
              ? `Pelunasan ${allocations[0]!.invoiceNumber}`
              : `Pelunasan ${allocations.length} invoice`,
          context,
          currency: baseCurrency,
          lines: [
            {
              accountId: input.cash_account_id,
              debit: sales ? amounts.baseBank : '0',
              credit: sales ? '0' : amounts.baseBank,
              currencyDebit: sales ? amounts.bankAmount : '0',
              currencyCredit: sales ? '0' : amounts.bankAmount,
              currencyCode: bankCurrency,
              exchangeRate: divideDecimal(amounts.baseBank, 2, amounts.bankAmount, 2, 8),
            },
            ...(compareDecimal(amounts.baseFee, '0') > 0
              ? [
                  {
                    accountId: input.processing_fee_account_id!,
                    debit: amounts.baseFee,
                    credit: '0',
                  },
                ]
              : []),
            ...allocations.map((allocation) => ({
              accountId: allocation.accountId,
              debit: sales ? '0' : allocation.base,
              credit: sales ? allocation.base : '0',
            })),
            ...fxLines,
          ],
        })
        for (const allocation of allocations)
          await connection.execute(
            `INSERT INTO ${party}_payment_allocations(${party}_payment_id,${type}_invoice_id,amount,base_amount) VALUES(?,?,?,?)`,
            [result.insertId, allocation.invoiceId, allocation.amount, allocation.base],
          )
        await connection.execute(
          `UPDATE ${party}_payments SET status='posted',journal_id=?,posted_by=?,posted_at=NOW(),fx_amount=?,carrying_base_amount=?,bank_currency=? WHERE id=?`,
          [journalId, context.userId, fxDifference, base, bankCurrency, result.insertId],
        )
        for (const allocation of allocations)
          await this.refreshInvoice(
            connection,
            companyId,
            sales,
            allocation.invoiceId,
            context.userId,
          )
        if (input.bank_account_id)
          await connection.execute(
            `UPDATE bank_accounts SET current_balance=current_balance+? WHERE id=? AND company_id=?`,
            [
              sales ? amounts.bankAmount : subtractDecimal('0', amounts.bankAmount),
              input.bank_account_id,
              companyId,
            ],
          )
        await new AuditService().log(connection, {
          companyId,
          userId: context.userId,
          module: `${party}-payments`,
          action: 'post',
          recordType: `${party}_payment`,
          recordId: result.insertId,
          recordNumber: number,
          newValue: {
            allocations: allocations.map(({ invoiceId, amount }) => ({ invoiceId, amount })),
            amount,
            processingFee: amounts.feeAmount,
            bankAmount: amounts.bankAmount,
            bankCurrency, invoiceCurrency: firstInvoice.currency, exchangeRate: paymentRate, carryingBaseAmount: base, fxDifference,
            paymentMethod:
              input.payment_method ?? (input.bank_account_id ? 'bank_transfer' : 'cash'),
            journalId,
          },
          requestId: context.requestId,
          ip: context.ip,
        })
        return { id: result.insertId, number, journalId, status: 'posted', invoiceIds }
      },
    )
  }
  reverse(
    companyId: number,
    sales: boolean,
    id: number,
    input: ReversalInput,
    context: PostingContext,
  ) {
    return idempotentOperation(
      companyId,
      input.request_key,
      sales ? 'receivable-settlement-reverse' : 'payable-settlement-reverse',
      { id, ...input },
      async (connection) => {
        const party = sales ? 'customer' : 'supplier',
          type = sales ? 'sales' : 'purchase'
        const [rows] = await connection.execute<RowDataPacket[]>(
          `SELECT * FROM ${party}_payments WHERE id=? AND company_id=? AND deleted_at IS NULL FOR UPDATE`,
          [id, companyId],
        )
        const payment = rows[0]
        if (!payment) throw new NotFoundError('Pelunasan tidak ditemukan')
        if (payment.status !== 'posted')
          throw new ConflictError('Hanya pelunasan posted yang dapat direversal')
        if (input.date < dateOnly(payment.payment_date))
          throw new ValidationError('Tanggal reversal tidak boleh sebelum pelunasan')
        const [base] = await connection.execute<RowDataPacket[]>(
          'SELECT base_currency FROM companies WHERE id=?',
          [companyId],
        )
        if ((payment.bank_currency ?? payment.currency) !== base[0]!.base_currency) {
          await new CurrencyService().cashPosition(
            connection,
            companyId,
            Number(payment.bank_account_id),
            input.date,
          )
          const [later] = await connection.execute<RowDataPacket[]>(
            `SELECT j.id FROM journals j JOIN journal_lines l ON l.journal_id=j.id WHERE j.company_id=? AND l.account_id=? AND j.status IN('posted','reversed') AND (j.journal_date>? OR(j.journal_date=? AND j.id>?)) LIMIT 1`,
            [
              companyId,
              payment.cash_account_id,
              dateOnly(payment.payment_date),
              dateOnly(payment.payment_date),
              payment.journal_id,
            ],
          )
          if (later.length)
            throw new ConflictError(
              'Balikkan transaksi rekening valas yang lebih baru dahulu sebelum membalik pelunasan ini',
            )
        }
        const [matched] = await connection.execute<RowDataPacket[]>(
          `SELECT m.id FROM bank_reconciliation_matches m JOIN journal_lines l ON l.id=m.journal_line_id WHERE l.journal_id=? AND m.status='confirmed' LIMIT 1`,
          [payment.journal_id],
        )
        if (matched.length)
          throw new ConflictError('Lepaskan rekonsiliasi bank sebelum reversal pelunasan')
        const reversalJournalId = await new PostingService().reversePostedJournal(connection, {
          companyId,
          journalId: Number(payment.journal_id),
          date: input.date,
          reason: input.reason,
          context,
          sourceType: `${party}_payment_reversal`,
          sourceId: id,
        })
        await connection.execute(
          `UPDATE ${party}_payments SET status='reversed',reversal_journal_id=?,reversed_by=?,reversed_at=NOW() WHERE id=?`,
          [reversalJournalId, context.userId, id],
        )
        if (payment.bank_account_id)
          await connection.execute(
            'UPDATE bank_accounts SET current_balance=current_balance+? WHERE id=? AND company_id=?',
            [
              sales ? subtractDecimal('0', String(payment.bank_amount)) : payment.bank_amount,
              payment.bank_account_id,
              companyId,
            ],
          )
        const [allocations] = await connection.execute<RowDataPacket[]>(
          `SELECT ${type}_invoice_id invoice_id FROM ${party}_payment_allocations WHERE ${party}_payment_id=?`,
          [id],
        )
        for (const allocation of allocations)
          await this.refreshInvoice(
            connection,
            companyId,
            sales,
            Number(allocation.invoice_id),
            context.userId,
          )
        await new AuditService().log(connection, {
          companyId,
          userId: context.userId,
          module: `${party}-payments`,
          action: 'reverse',
          recordType: `${party}_payment`,
          recordId: id,
          newValue: { reversalJournalId, reason: input.reason },
        })
        return { id, status: 'reversed', reversalJournalId }
      },
    )
  }
  remove(companyId: number, sales: boolean, id: number, context: PostingContext) {
    return transaction(async (connection) => {
      const party = sales ? 'customer' : 'supplier'
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT * FROM ${party}_payments WHERE id=? AND company_id=? AND deleted_at IS NULL FOR UPDATE`,
        [id, companyId],
      )
      const payment = rows[0]
      if (!payment) throw new NotFoundError('Pelunasan tidak ditemukan')
      if (!['reversed', 'cancelled'].includes(String(payment.status)))
        throw new ConflictError('Pelunasan aktif harus dibalikkan terlebih dahulu sebelum dihapus')
      await new AuditService().log(connection, {
        companyId,
        userId: context.userId,
        module: `${party}-payments`,
        action: 'delete',
        recordType: `${party}_payment`,
        recordId: id,
        recordNumber: String(payment.payment_number),
        oldValue: payment,
        requestId: context.requestId,
        ip: context.ip,
      })
      await connection.execute(
        `UPDATE ${party}_payments SET deleted_at=NOW(),deleted_by=?,updated_by=? WHERE id=? AND company_id=?`,
        [context.userId, context.userId, id, companyId],
      )
      return { id, deleted: true }
    })
  }
  async refreshInvoice(
    connection: QueryExecutor,
    companyId: number,
    sales: boolean,
    id: number,
    userId?: number,
  ) {
    const type = sales ? 'sales' : 'purchase',
      party = sales ? 'customer' : 'supplier'
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT i.grand_total,COALESCE((SELECT SUM(a.amount) FROM ${party}_payment_allocations a JOIN ${party}_payments p ON p.id=a.${party}_payment_id WHERE a.${type}_invoice_id=i.id AND p.company_id=i.company_id AND p.status='posted'),0) paid,COALESCE((SELECT SUM(r.grand_total) FROM ${type}_returns r WHERE r.${type}_invoice_id=i.id AND r.company_id=i.company_id AND r.status='posted'),0) returned,COALESCE((SELECT SUM(ca.amount) FROM party_credit_applications ca JOIN party_credits pc ON pc.id=ca.party_credit_id WHERE ca.company_id=i.company_id AND ca.target_invoice_id=i.id AND ca.status='posted' AND ca.application_type='invoice' AND pc.party_type=?),0) credit_applied FROM ${type}_invoices i WHERE i.id=? AND i.company_id=?`,
      [sales ? 'customer' : 'supplier', id, companyId],
    )
    const row = rows[0]!
    const remaining = subtractDecimal(
      String(row.grand_total),
      addDecimal([String(row.paid), String(row.returned), String(row.credit_applied)]),
    )
    const done = compareDecimal(remaining, '0') <= 0
    const settled = addDecimal([String(row.paid), String(row.credit_applied)])
    await connection.execute(
      `UPDATE ${type}_invoices SET paid_amount=?,outstanding_amount=?,status=?,payment_status=?,version=version+1 WHERE id=? AND company_id=?`,
      [
        row.paid,
        done ? '0.00' : remaining,
        done ? 'paid' : compareDecimal(settled, '0') > 0 ? 'partially_paid' : 'posted',
        done ? 'paid' : compareDecimal(settled, '0') > 0 ? 'partial' : 'unpaid',
        id,
        companyId,
      ],
    )
    if (userId) {
      const { CreditService } = await import('./CreditService')
      await new CreditService().syncInvoiceCredit(connection, companyId, sales, id, userId)
    }
  }
}
