import { payrollDay, payrollProration, proratedMoney } from './payroll-proration'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { db, transaction } from '../config/database'
import { ConflictError, NotFoundError, ValidationError } from '../utils/AppError'
import { AuditService } from './AuditService'
import { payrollRound, readComponentSnapshot, type ComponentSnapshot } from './payroll-component-calculation'
type Row = RowDataPacket & Record<string, any>
type Actor = { userId: number; requestId?: string | null; ip?: string | null }
export class PayrollComponentService {
 async list(companyId: number) {
  return (await db.query<Row[]>('SELECT * FROM payroll_components WHERE company_id=? ORDER BY is_active DESC,name',[companyId]))[0]
 }
 async save(companyId: number, id: number | null, input: Record<string, any>, actor: Actor) {
  return transaction(async cx => {
   let previous: Row | null = null
   if (id) {
    const [rows] = await cx.query<Row[]>('SELECT * FROM payroll_components WHERE company_id=? AND id=? FOR UPDATE',[companyId,id])
    previous = rows[0] ?? null
    if (!previous) throw new NotFoundError('Komponen tidak ditemukan')
    if (Number(input.version) !== Number(previous.version)) throw new ConflictError('Komponen telah diubah pengguna lain. Muat ulang.')
   }
   if (input.kind === 'deduction' && (input.channel !== 'payroll' || input.bpjs_base)) throw new ValidationError('Potongan harus melalui payroll dan tidak menambah dasar BPJS')
   if (input.effective_to && input.effective_to < input.effective_from) throw new ValidationError('Tanggal akhir harus setelah tanggal efektif')
   for (const [key, type] of [['expense_account_id','expense'],['contra_account_id','liability']]) {
    const required = key === 'expense_account_id' ? input.kind === 'earning' : input.kind === 'deduction' || input.channel === 'noncash'
    if (!required) { input[key!] = null; continue }
    const [accounts] = await cx.query<Row[]>('SELECT id,account_type,is_posting,is_active FROM accounts WHERE id=? AND company_id=? AND deleted_at IS NULL FOR SHARE',[input[key!],companyId])
    if (!accounts[0] || accounts[0].account_type !== type || !accounts[0].is_posting || !accounts[0].is_active) throw new ValidationError('Pilih akun aktif yang dapat diposting: '+key)
   }
   const fields = ['code','name','kind','channel','basis','rate','taxable','bpjs_base','expense_account_id','contra_account_id','effective_from','effective_to','policy_reference','is_active']
   if (id) await cx.query(`UPDATE payroll_components SET ${fields.map(f=>f+'=?').join(',')},version=version+1 WHERE id=? AND company_id=?`,[...fields.map(f=>input[f]??null),id,companyId])
   else { const [r] = await cx.query<any>(`INSERT INTO payroll_components(company_id,${fields.join(',')}) VALUES(?,${fields.map(()=>'?').join(',')})`,[companyId,...fields.map(f=>input[f]??null)]); id=Number(r.insertId) }
   await new AuditService().log(cx,{companyId,userId:actor.userId,module:'payroll',action:previous?'component_update':'component_create',recordType:'payroll_component',recordId:id!,oldValue:previous,newValue:input,requestId:actor.requestId,ip:actor.ip})
   return {id}
  })
 }
 async replaceLines(cx: PoolConnection, companyId: number, run: Row, entry: Row, inputs: any[]) {
  const [existing] = await cx.query<Row[]>('SELECT * FROM payroll_entry_components WHERE entry_id=?',[entry.id])
  const output: any[] = []
  const seen = new Set<number>()
  for (const input of inputs) {
   if (seen.has(input.component_id)) throw new ValidationError('Komponen yang sama tidak boleh dimasukkan dua kali')
   seen.add(input.component_id)
   let snapshot: ComponentSnapshot
   const old = existing.find(l=>Number(l.id)===input.id && Number(l.component_id)===input.component_id)
   if (input.id && !old) throw new ValidationError('Baris komponen tidak sesuai pegawai ini')
   if (old) snapshot=readComponentSnapshot(old.snapshot)
   else {
    const [rows] = await cx.query<Row[]>('SELECT * FROM payroll_components WHERE id=? AND company_id=? FOR SHARE',[input.component_id,companyId])
    const c=rows[0], date=String(run.date_to).slice(0,10)
    const d=(v:any)=>typeof v==='string'?v.slice(0,10):new Date(v).toISOString().slice(0,10)
    const end=typeof run.date_to==='string'?date:d(run.date_to)
    if (!c || !c.is_active || d(c.effective_from)>end || (c.effective_to && d(c.effective_to)<payrollDay(run.date_from))) throw new ValidationError('Komponen tidak aktif atau belum berlaku pada periode ini')
    snapshot={...c,id:Number(c.id),rate:Number(c.rate),taxable:Boolean(c.taxable),bpjs_base:Boolean(c.bpjs_base),effective_from:d(c.effective_from),effective_to:c.effective_to?d(c.effective_to):null} as ComponentSnapshot
   }
   snapshot={...snapshot,basis:'nominal',rate:0}
   delete snapshot.recurring_metadata
   const quantity=1, amount=payrollRound(Number(input.amount??0))
   const taxable= snapshot.taxable ? (input.taxable_amount == null ? amount : Number(input.taxable_amount)) : 0
   if (!Number.isFinite(amount)||amount<0||amount>999999999999||!Number.isFinite(taxable)||taxable<0||taxable>amount) throw new ValidationError('Nominal atau bagian kena pajak tidak valid')
   if (snapshot.taxable && taxable!==amount && !String(input.tax_note??'').trim()) throw new ValidationError('Jelaskan dasar pengecualian sebagian penghasilan dari pajak')
   // The snapshot preserves the tax explanation and policy used for this employee/period.
   const stored={...snapshot,tax_note:String(input.tax_note??'').trim()}
   output.push({recurring_assignment_id:null,component_id:input.component_id,snapshot:stored,quantity,amount,taxable_amount:taxable,source_reference:input.source_reference?.trim()||null,source_journal_id:null})
  }
  for (const line of output.filter(l=>l.snapshot.channel.startsWith('external_')).sort((a,b)=>String(a.source_reference).localeCompare(String(b.source_reference)))) {
   if (!line.source_reference) throw new ValidationError('Komponen dibayar terpisah wajib menunjuk nomor jurnal sumber yang sudah posted')
   const [journals]=await cx.query<Row[]>('SELECT id,status,source_type,reversal_journal_id FROM journals WHERE company_id=? AND journal_number=? FOR UPDATE',[companyId,line.source_reference])
   const journal=journals[0]
   if (!journal || journal.status!=='posted'||journal.reversal_journal_id||String(journal.source_type??'').startsWith('payroll')) throw new ValidationError('Jurnal sumber harus posted, belum dibalik, dan bukan jurnal payroll')
   line.source_journal_id=Number(journal.id)
  }
  await cx.query('DELETE FROM payroll_entry_components WHERE entry_id=?',[entry.id])
  for (const l of output) await cx.query('INSERT INTO payroll_entry_components(entry_id,component_id,snapshot,quantity,amount,taxable_amount,source_journal_id,source_reference,recurring_assignment_id) VALUES(?,?,?,?,?,?,?,?,?)',[entry.id,l.component_id,JSON.stringify(l.snapshot),l.quantity,l.amount,l.taxable_amount,l.source_journal_id,l.source_reference,l.recurring_assignment_id])
  await this.validateSources(cx,companyId,Number(run.id))
 }
 async validateSources(cx: PoolConnection, companyId: number, runId: number) {
  const [sources]=await cx.query<Row[]>(`SELECT DISTINCT c.source_journal_id FROM payroll_entry_components c JOIN payroll_entries e ON e.id=c.entry_id WHERE e.run_id=? AND c.source_journal_id IS NOT NULL ORDER BY c.source_journal_id`,[runId])
  for (const source of sources) {
   const [j]=await cx.query<Row[]>('SELECT status,reversal_journal_id FROM journals WHERE id=? AND company_id=? FOR UPDATE',[source.source_journal_id,companyId])
   if (!j[0]||j[0].status!=='posted'||j[0].reversal_journal_id) throw new ValidationError('Jurnal sumber fasilitas/pembayaran terpisah sudah tidak valid')
   const [lines]=await cx.query<Row[]>('SELECT amount,snapshot FROM payroll_entry_components WHERE source_journal_id=? FOR UPDATE',[source.source_journal_id])
   const allocations=new Map<number,number>()
   for (const l of lines) { const account=Number(readComponentSnapshot(l.snapshot).expense_account_id); allocations.set(account,(allocations.get(account)??0)+Number(l.amount)) }
   for (const [account,amount] of allocations) {
    const [values]=await cx.query<Row[]>('SELECT COALESCE(SUM(debit-credit),0) amount FROM journal_lines WHERE journal_id=? AND account_id=?',[source.source_journal_id,account])
    if (payrollRound(amount)>Number(values[0]!.amount)+0.005) throw new ValidationError('Alokasi fasilitas melebihi biaya pada akun jurnal sumber')
   }
  }
 }
}
