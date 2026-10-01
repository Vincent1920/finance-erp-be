import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { db } from '../config/database'
import type { QueryExecutor } from '../types/database'
import { addDecimal, compareDecimal, multiplyDecimal, subtractDecimal } from '../utils/decimal'
import { ConflictError, NotFoundError, ValidationError } from '../utils/AppError'
import { AuditService } from './AuditService'
import { BusinessValidationService } from './BusinessValidationService'
import { idempotentOperation } from './IdempotentOperation'
import { NumberSequenceService } from './NumberSequenceService'
import { PostingService, type PostingContext } from './PostingService'
import type { CreditActionInput, ReversalInput } from '../validators/operations.validator'
const dateOnly = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)

export class CreditService {
  async list(companyId: number, sales: boolean, partyId?: number) {
    const party = sales ? 'customers' : 'suppliers'
    const conditions = ['c.company_id=?', 'c.party_type=?']
    const values: Array<string | number> = [companyId, sales ? 'customer' : 'supplier']
    if (partyId) { conditions.push('c.party_id=?'); values.push(partyId) }
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT c.*,p.code party_code,p.name party_name FROM party_credits c JOIN ${party} p ON p.id=c.party_id AND p.company_id=c.company_id WHERE ${conditions.join(' AND ')} ORDER BY c.credit_date DESC,c.id DESC`,
      values,
    )
    return rows
  }

  async syncInvoiceCredit(connection: QueryExecutor, companyId: number, sales: boolean, invoiceId: number, userId: number) {
    const type = sales ? 'sales' : 'purchase', party = sales ? 'customer' : 'supplier', control = sales ? 'receivable' : 'payable'
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT i.*,p.${control}_account_id control_account_id,
       COALESCE((SELECT SUM(a.amount) FROM ${party}_payment_allocations a JOIN ${party}_payments py ON py.id=a.${party}_payment_id WHERE a.${type}_invoice_id=i.id AND py.status='posted'),0) paid,
       COALESCE((SELECT SUM(r.grand_total) FROM ${type}_returns r WHERE r.${type}_invoice_id=i.id AND r.status='posted'),0) returned
       FROM ${type}_invoices i JOIN ${party}s p ON p.id=i.${party}_id AND p.company_id=i.company_id WHERE i.id=? AND i.company_id=? FOR UPDATE`,
      [invoiceId, companyId],
    )
    const invoice = rows[0]
    if (!invoice) throw new NotFoundError('Invoice sumber kredit tidak ditemukan')
    const excessRaw = subtractDecimal(addDecimal([String(invoice.paid),String(invoice.returned)]),String(invoice.grand_total))
    const excess = compareDecimal(excessRaw,'0') > 0 ? excessRaw : '0.00'
    const [existingRows] = await connection.execute<RowDataPacket[]>(
      "SELECT * FROM party_credits WHERE company_id=? AND party_type=? AND source_type='invoice_excess' AND source_id=? FOR UPDATE",
      [companyId,sales?'customer':'supplier',invoiceId],
    )
    const existing = existingRows[0]
    if (!existing && compareDecimal(excess,'0') === 0) return null
    const used = existing ? subtractDecimal(String(existing.original_amount),String(existing.remaining_amount)) : '0.00'
    if (compareDecimal(excess,used) < 0) throw new ConflictError('Kredit sudah digunakan; balikkan aplikasi/refund sebelum membalik transaksi sumber')
    const remaining = subtractDecimal(excess,used)
    const status = compareDecimal(excess,'0') === 0 ? 'void' : compareDecimal(remaining,'0') === 0 ? 'used' : compareDecimal(remaining,excess) < 0 ? 'partially_used' : 'open'
    if (existing) {
      await connection.execute('UPDATE party_credits SET original_amount=?,remaining_amount=?,status=? WHERE id=?',[excess,remaining,status,existing.id])
      return Number(existing.id)
    }
    const number = await new NumberSequenceService().next(connection,companyId,sales?'customer_credit':'supplier_credit',dateOnly(invoice.invoice_date))
    const [created] = await connection.execute<ResultSetHeader>(
      `INSERT INTO party_credits(company_id,credit_number,party_type,party_id,source_type,source_id,credit_date,currency,exchange_rate,control_account_id,original_amount,remaining_amount,status,created_by) VALUES(?,?,?,?,'invoice_excess',?,?,?,?,?,?,?,'open',?)`,
      [companyId,number,sales?'customer':'supplier',invoice[`${party}_id`],invoiceId,dateOnly(invoice.invoice_date),invoice.currency,invoice.exchange_rate,invoice.control_account_id,excess,excess,userId],
    )
    return created.insertId
  }

  apply(companyId: number, sales: boolean, input: CreditActionInput, context: PostingContext) {
    return idempotentOperation(companyId,input.request_key,sales?'customer-credit-apply':'supplier-credit-apply',input,async connection=>{
      if (!input.invoice_id) throw new ValidationError('Pilih invoice tujuan kredit')
      const credit = await this.lockCredit(connection,companyId,sales,input.credit_id)
      this.checkAvailable(credit,input.amount,input.date)
      const type=sales?'sales':'purchase',party=sales?'customer':'supplier'
      const [invoices]=await connection.execute<RowDataPacket[]>(`SELECT * FROM ${type}_invoices WHERE id=? AND company_id=? FOR UPDATE`,[input.invoice_id,companyId])
      const invoice=invoices[0]
      if(!invoice||!['posted','partially_paid'].includes(String(invoice.status)))throw new ConflictError('Invoice tujuan harus posted dan masih memiliki saldo')
      if(Number(invoice[`${party}_id`])!==Number(credit.party_id)||invoice.currency!==credit.currency)throw new ValidationError('Kredit dan invoice harus untuk pihak serta mata uang yang sama')
      if(input.date<dateOnly(invoice.invoice_date))throw new ValidationError('Tanggal aplikasi tidak boleh sebelum invoice')
      if(compareDecimal(input.amount,String(invoice.outstanding_amount))>0)throw new ConflictError(`Kredit melebihi sisa invoice ${invoice.outstanding_amount}`)
      const base=multiplyDecimal(input.amount,2,String(credit.exchange_rate),8)
      const [created]=await connection.execute<ResultSetHeader>(`INSERT INTO party_credit_applications(company_id,party_credit_id,application_type,target_invoice_id,application_date,amount,base_amount,reference,status,created_by) VALUES(?,?,'invoice',?,?,?,?,?,'posted',?)`,[companyId,credit.id,input.invoice_id,input.date,input.amount,base,input.reference,context.userId])
      await this.consume(connection,credit,input.amount)
      const { SettlementService } = await import('./SettlementService')
      await new SettlementService().refreshInvoice(connection,companyId,sales,input.invoice_id)
      await new AuditService().log(connection,{companyId,userId:context.userId,module:'party-credits',action:'apply',recordType:'party_credit_application',recordId:created.insertId,newValue:input})
      return {id:created.insertId,status:'posted'}
    })
  }

  refund(companyId:number,sales:boolean,input:CreditActionInput,context:PostingContext){
    return idempotentOperation(companyId,input.request_key,sales?'customer-credit-refund':'supplier-credit-refund',input,async connection=>{
      if(!input.cash_account_id)throw new ValidationError('Pilih akun kas/bank untuk refund')
      const credit=await this.lockCredit(connection,companyId,sales,input.credit_id)
      this.checkAvailable(credit,input.amount,input.date)
      await new BusinessValidationService().ensureActiveReference(connection,{companyId,table:'accounts',id:input.cash_account_id,label:'Akun kas/bank',postingOnly:true})
      if(Number(credit.control_account_id)===input.cash_account_id)throw new ValidationError('Akun kas/bank harus berbeda dari akun kontrol')
      if(input.bank_account_id){const [banks]=await connection.execute<RowDataPacket[]>('SELECT * FROM bank_accounts WHERE id=? AND company_id=? AND is_active=TRUE AND deleted_at IS NULL',[input.bank_account_id,companyId]);if(!banks[0]||Number(banks[0].gl_account_id)!==input.cash_account_id||banks[0].currency!==credit.currency)throw new ValidationError('Rekening bank, akun GL, dan mata uang tidak cocok')}
      const base=multiplyDecimal(input.amount,2,String(credit.exchange_rate),8)
      const number=await new NumberSequenceService().next(connection,companyId,sales?'customer_refund':'supplier_refund',input.date)
      const journalId=await new PostingService().createPostedJournal(connection,{companyId,sourceType:sales?'customer_credit_refund':'supplier_credit_refund',sourceId:credit.id,date:input.date,reference:number,description:`Refund kredit ${credit.credit_number}`,context,lines:[{accountId:Number(credit.control_account_id),debit:sales?base:'0',credit:sales?'0':base},{accountId:input.cash_account_id,debit:sales?'0':base,credit:sales?base:'0'}]})
      const [created]=await connection.execute<ResultSetHeader>(`INSERT INTO party_credit_applications(company_id,party_credit_id,application_type,application_date,amount,base_amount,cash_account_id,bank_account_id,reference,journal_id,status,created_by) VALUES(?,?,'refund',?,?,?,?,?,?,?,'posted',?)`,[companyId,credit.id,input.date,input.amount,base,input.cash_account_id,input.bank_account_id??null,input.reference||number,journalId,context.userId])
      await this.consume(connection,credit,input.amount)
      if(input.bank_account_id)await connection.execute('UPDATE bank_accounts SET current_balance=current_balance+? WHERE id=? AND company_id=?',[sales?subtractDecimal('0',input.amount):input.amount,input.bank_account_id,companyId])
      await new AuditService().log(connection,{companyId,userId:context.userId,module:'party-credits',action:'refund',recordType:'party_credit_application',recordId:created.insertId,recordNumber:number,newValue:{...input,journalId}})
      return {id:created.insertId,number,journalId,status:'posted'}
    })
  }

  reverse(companyId:number,id:number,input:ReversalInput,context:PostingContext){
    return idempotentOperation(companyId,input.request_key,'credit-application-reverse',{id,...input},async connection=>{
      const [rows]=await connection.execute<RowDataPacket[]>(`SELECT a.*,c.party_type,c.original_amount,c.remaining_amount,c.credit_number FROM party_credit_applications a JOIN party_credits c ON c.id=a.party_credit_id WHERE a.id=? AND a.company_id=? FOR UPDATE`,[id,companyId])
      const app=rows[0];if(!app)throw new NotFoundError('Aplikasi kredit tidak ditemukan');if(app.status!=='posted')throw new ConflictError('Aplikasi kredit sudah direversal');if(input.date<dateOnly(app.application_date))throw new ValidationError('Tanggal reversal tidak boleh sebelum aplikasi')
      const sales=app.party_type==='customer'
      let reversalJournalId:null|number=null
      if(app.journal_id){reversalJournalId=await new PostingService().reversePostedJournal(connection,{companyId,journalId:Number(app.journal_id),date:input.date,reason:input.reason,context,sourceType:'credit_application_reversal',sourceId:id});if(app.bank_account_id)await connection.execute('UPDATE bank_accounts SET current_balance=current_balance+? WHERE id=? AND company_id=?',[sales?app.amount:subtractDecimal('0',String(app.amount)),app.bank_account_id,companyId])}
      await connection.execute("UPDATE party_credit_applications SET status='reversed',reversal_journal_id=?,reversed_by=?,reversed_at=NOW() WHERE id=?",[reversalJournalId,context.userId,id])
      const restored=addDecimal([String(app.remaining_amount),String(app.amount)]),status=compareDecimal(restored,String(app.original_amount))===0?'open':'partially_used'
      await connection.execute('UPDATE party_credits SET remaining_amount=?,status=? WHERE id=?',[restored,status,app.party_credit_id])
      if(app.target_invoice_id){const { SettlementService }=await import('./SettlementService');await new SettlementService().refreshInvoice(connection,companyId,sales,Number(app.target_invoice_id))}
      return {id,status:'reversed',reversalJournalId}
    })
  }

  private async lockCredit(connection:QueryExecutor,companyId:number,sales:boolean,id:number){const [rows]=await connection.execute<RowDataPacket[]>('SELECT * FROM party_credits WHERE id=? AND company_id=? AND party_type=? FOR UPDATE',[id,companyId,sales?'customer':'supplier']);if(!rows[0])throw new NotFoundError('Saldo kredit tidak ditemukan');return rows[0]}
  private checkAvailable(credit:RowDataPacket,amount:string,date:string){if(!['open','partially_used'].includes(String(credit.status)))throw new ConflictError('Saldo kredit sudah habis atau dibatalkan');if(compareDecimal(amount,String(credit.remaining_amount))>0)throw new ConflictError(`Jumlah melebihi saldo kredit ${credit.remaining_amount}`);if(date<dateOnly(credit.credit_date))throw new ValidationError('Tanggal tidak boleh sebelum tanggal kredit')}
  private async consume(connection:QueryExecutor,credit:RowDataPacket,amount:string){const remaining=subtractDecimal(String(credit.remaining_amount),amount),status=compareDecimal(remaining,'0')===0?'used':'partially_used';await connection.execute('UPDATE party_credits SET remaining_amount=?,status=? WHERE id=?',[remaining,status,credit.id])}
}
