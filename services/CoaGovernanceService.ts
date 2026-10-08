import {standardCoa,standardCoaVersion} from '../constants/standard-coa'
import { ReportRepository } from '../repositories/ReportRepository'
import { addDecimal,subtractDecimal } from '../utils/decimal'
import type { RowDataPacket } from 'mysql2/promise'
import { db, transaction } from '../config/database'
import { EntityService } from './EntityService'
import { AccountMappingService, accountMappingDefinitions, requiredAccountMappingKeys } from './AccountMappingService'
import { controlAccountIds } from './CoaControlService'
import { accountSchema } from '../validators/entity.validator'
import { z } from 'zod'
import { AuditService } from './AuditService'
import { ConflictError, NotFoundError } from '../utils/AppError'
import type { SystemActor } from './SystemUserService'
import type { QueryExecutor } from '../types/database'

export { reportGroups } from '../constants/coa-report-groups'
import { reportGroups } from '../constants/coa-report-groups'

const proposalSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('account'),target_id:z.number().int().positive(),changes:accountSchema.partial(),reason:z.string().trim().min(5).max(500)}),
  z.object({kind:z.literal('mapping'),mapping_key:z.string(),account_id:z.number().int().positive(),reason:z.string().trim().min(5).max(500)}),
])
const decode=(v:unknown):any=>typeof v==='string'?JSON.parse(v):v
const stable=(v:any)=>JSON.stringify(v,Object.keys(v).sort())
export class CoaGovernanceService {
  private accounts=new EntityService('accounts')
  private mappings=new AccountMappingService()
  async overview(companyId:number) {
    const [accounts,requests,mappings,controls]=await Promise.all([
      db.execute<RowDataPacket[]>(`SELECT id,code,name,account_type,normal_balance,parent_id,is_header,is_posting,is_active,allow_manual_journal,report_group,level FROM accounts WHERE company_id=? AND deleted_at IS NULL ORDER BY FIELD(account_type,'asset','liability','equity','revenue','cogs','expense','other_income','other_expense'),COALESCE(presentation_order,990000),code`,[companyId]),
      db.execute<RowDataPacket[]>(`SELECT r.*,u.name requester_name,v.name reviewer_name FROM coa_change_requests r JOIN users u ON u.id=r.created_by LEFT JOIN users v ON v.id=r.reviewed_by WHERE r.company_id=? ORDER BY r.id DESC LIMIT 100`,[companyId]),
      this.mappings.list(companyId),controlAccountIds(db,companyId),
    ])
    const problems=[] as Array<{key:string;label:string}>
    for(const key of requiredAccountMappingKeys){
      try {await this.mappings.resolve(db,companyId,this.mappings.assertKey(key))} catch(e){problems.push({key,label:e instanceof Error?e.message:'Mapping tidak valid'})}
    }
    const controlIds=[...controls]
    const manualHistory=controlIds.length ? (await db.execute<RowDataPacket[]>(`SELECT DISTINCT j.id,j.journal_number,j.journal_date,j.description FROM journals j JOIN journal_lines l ON l.journal_id=j.id WHERE j.company_id=? AND j.source_type IS NULL AND j.status IN ('posted','reversed') AND l.account_id IN (${controlIds.map(()=>'?').join(',')}) ORDER BY j.id DESC LIMIT 20`,[companyId,...controlIds]))[0] : []
    return {manualHistory,accounts:accounts[0].map(a=>({...a,is_control:controls.has(Number(a.id)),manual_effectively_allowed:Boolean(a.allow_manual_journal)&&!controls.has(Number(a.id))} as RowDataPacket & {is_control:boolean;manual_effectively_allowed:boolean})),requests:requests[0],mappings,reportGroups,ready:!problems.length,problems,templates:[{key:'trading',name:'Perdagangan'},{key:'services',name:'Jasa'},{key:'manufacturing',name:'Manufaktur'}]}
  }
  private async current(cx:QueryExecutor,companyId:number,kind:string,id:number|null,key:string|null) {
    const [rows]=await cx.execute<RowDataPacket[]>(kind==='account'?'SELECT * FROM accounts WHERE company_id=? AND id=? AND deleted_at IS NULL FOR UPDATE':'SELECT account_id FROM account_mappings WHERE company_id=? AND mapping_key=? FOR UPDATE',[companyId,kind==='account'?id:key])
    if(kind==='account'&&!rows.length)throw new NotFoundError('Akun tidak ditemukan')
    return JSON.parse(JSON.stringify(rows[0]??{}))
  }
  async propose(actor:SystemActor,body:unknown) {
    const input=proposalSchema.parse(body)
    return transaction(async cx=>{
      await cx.execute('SELECT id FROM companies WHERE id=? FOR UPDATE',[actor.companyId])
      const before=await this.current(cx,actor.companyId,input.kind,input.kind==='account'?input.target_id:null,input.kind==='mapping'?input.mapping_key:null)
      if(input.kind==='mapping')await this.mappings.resolve(cx,actor.companyId,this.mappings.assertKey(input.mapping_key),input.account_id)
      if(input.kind==='account'&&input.changes.report_group){
        const group=reportGroups.find(g=>g.key===input.changes.report_group)
        if(!group||group.type!==String(input.changes.account_type??before.account_type))throw new ConflictError('Kelompok laporan tidak sesuai tipe akun')
      }
      const after=input.kind==='account'?input.changes:{account_id:input.account_id}
      if(!Object.keys(after).length)throw new ConflictError('Tidak ada perubahan yang diajukan')
      const [insert]=await cx.execute<any>('INSERT INTO coa_change_requests(company_id,kind,target_id,mapping_key,before_json,after_json,reason,created_by) VALUES(?,?,?,?,?,?,?,?)',[actor.companyId,input.kind,input.kind==='account'?input.target_id:null,input.kind==='mapping'?input.mapping_key:null,JSON.stringify(before),JSON.stringify(after),input.reason,actor.id])
      await new AuditService().log(cx,{companyId:actor.companyId,userId:actor.id,module:'accounts',action:'propose_change',recordType:'coa_change_request',recordId:Number(insert.insertId),oldValue:before,newValue:after,requestId:actor.requestId})
      return {id:Number(insert.insertId),status:'pending'}
    })
  }
  async review(actor:SystemActor,id:number,approve:boolean,note:string) {
    return transaction(async cx=>{
      await cx.execute('SELECT id FROM companies WHERE id=? FOR UPDATE',[actor.companyId])
      const [rows]=await cx.execute<RowDataPacket[]>('SELECT * FROM coa_change_requests WHERE company_id=? AND id=? FOR UPDATE',[actor.companyId,id])
      const r=rows[0];if(!r)throw new NotFoundError();if(r.status!=='pending')throw new ConflictError('Permintaan sudah diproses')
      if(Number(r.created_by)===actor.id)throw new ConflictError('Pengaju tidak boleh meninjau perubahan sendiri')
      if(approve){
        const current=await this.current(cx,actor.companyId,r.kind,r.target_id,r.mapping_key)
        if(stable(current)!==stable(decode(r.before_json)))throw new ConflictError('Data telah berubah sejak pengajuan. Tolak dan ajukan ulang berdasarkan data terbaru.')
        if(r.kind==='account')await this.accounts.updateInTransaction(cx,Number(r.target_id),actor.companyId,decode(r.after_json),{userId:actor.id,approvedCoaChange:true,requestId:actor.requestId})
        else await this.mappings.upsertInTransaction(cx,actor,this.mappings.assertKey(r.mapping_key),Number(decode(r.after_json).account_id),true)
      }
      await cx.execute('UPDATE coa_change_requests SET status=?,reviewed_by=?,review_note=?,reviewed_at=NOW() WHERE id=?',[approve?'approved':'rejected',actor.id,note,id])
      await new AuditService().log(cx,{companyId:actor.companyId,userId:actor.id,module:'accounts',action:approve?'approve_change':'reject_change',recordType:'coa_change_request',recordId:id,newValue:{note,status:approve?'approved':'rejected'},requestId:actor.requestId})
      return {id,status:approve?'approved':'rejected'}
    })
  }
  async groupedReport(companyId:number,date:string) {
    return transaction(async cx=>{
      const repo=new ReportRepository(cx)
      const rows=await repo.accountBalancesAsOf(companyId,date)
      const [accounts]=await cx.execute<RowDataPacket[]>('SELECT id,report_group FROM accounts WHERE company_id=?',[companyId])
      const [companies]=await cx.execute<RowDataPacket[]>('SELECT base_currency FROM companies WHERE id=?',[companyId])
      const grouped=new Map<string,{key:string;label:string;type:string;debit:string;credit:string;net:string;accounts:number}>()
      for(const row of rows){
        const key=String(accounts.find(a=>Number(a.id)===Number(row.id))?.report_group??'')||`ungrouped_${row.account_type}`
        const known=reportGroups.find(g=>g.key===key&&g.type===row.account_type)
        const bucketKey=`${row.account_type}:${key}`
        const group=grouped.get(bucketKey)??{key,label:known?.label??`Belum baku / ${key}`,type:String(row.account_type),debit:'0.00',credit:'0.00',net:'0.00',accounts:0}
        group.debit=addDecimal([group.debit,String(row.debit)]);group.credit=addDecimal([group.credit,String(row.credit)]);group.net=subtractDecimal(group.debit,group.credit);group.accounts++;grouped.set(bucketKey,group)
      }
      return {date,currency:companies[0]?.base_currency,groups:[...grouped.values()],totalDebit:addDecimal(rows.map(r=>String(r.debit))),totalCredit:addDecimal(rows.map(r=>String(r.credit)))}
    })
  }

  async installTemplate(actor:SystemActor,industry:string) {
    return transaction(cx=>this.installTemplateInTransaction(cx,actor,industry))
  }
  async installTemplateInTransaction(cx:QueryExecutor,actor:SystemActor,industry:string) {
    if(!['trading','services','manufacturing'].includes(industry))throw new ConflictError('Template tidak dikenal')
      await cx.execute('SELECT id FROM companies WHERE id=? FOR UPDATE',[actor.companyId])
      const [existing]=await cx.execute<RowDataPacket[]>('SELECT id FROM accounts WHERE company_id=? LIMIT 1',[actor.companyId])
      if(existing.length)throw new ConflictError('Template hanya untuk perusahaan yang belum memiliki COA. Akun lama tidak ditimpa.')
      const ids=new Map<string,number>()
      const rows=[...standardCoa]
      if(industry==='manufacturing')for(const [index,name] of ['Bahan baku','Barang dalam proses','Barang jadi'].entries())rows.push({code:String(115101+index),name,type:'asset',parent:'115000',group:'inventory',normal:'debit',mapping:null,header:false})
      rows.sort((a,b)=>a.code.localeCompare(b.code))
      for(const row of rows){
        const saved=await this.accounts.createInTransaction(cx,actor.companyId,{code:row.code,name:row.mapping==='REVENUE'&&industry==='services'?'Pendapatan jasa':row.name,account_type:row.type,normal_balance:row.normal,parent_id:row.parent?ids.get(row.parent):null,is_header:row.header,is_posting:!row.header,is_active:true,allow_manual_journal:!row.header&&!['AR_CONTROL','AP_CONTROL','INVENTORY','INPUT_VAT','OUTPUT_VAT','WITHHOLDING_TAX'].includes(row.mapping??''),report_group:row.group,presentation_order:Number(row.code)},{userId:actor.id})
        ids.set(row.code,Number(saved!.id))
        if(row.mapping)await this.mappings.upsertInTransaction(cx,actor,row.mapping,Number(saved!.id),true)
      }
      await new AuditService().log(cx,{companyId:actor.companyId,userId:actor.id,module:'accounts',action:'install_industry_template',recordType:'company',recordId:actor.companyId,newValue:{industry,standard:standardCoaVersion}})
      return {industry,status:'installed',standard:standardCoaVersion}
  }
}
