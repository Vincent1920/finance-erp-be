import { db } from '../config/database'
import type { RowDataPacket,ResultSetHeader } from 'mysql2/promise'
import type { AuthUser } from '../types/hono'
import { z } from 'zod'
import { generalLedgerQuerySchema,dateRangeQuerySchema } from '../validators/report.validator'
import {financialExport} from './FinancialExportService'
import { inventoryCardQuerySchema } from '../validators/inventory.validator'
import { ReportRepository } from '../repositories/ReportRepository'
import { InventoryService } from './InventoryService'
import { InventoryRepository } from '../repositories/InventoryRepository'
import { csvFile,pdfFile,type FileSnapshot } from './ReportFileService'
import { ForbiddenError,NotFoundError,ValidationError } from '../utils/AppError'
export const exportSchema=z.object({report:z.enum(['general_ledger','stock_summary','stock_card','profit_loss','balance_sheet','cash_flow','trial_balance']),format:z.enum(['csv','pdf']),filters:z.record(z.string(),z.unknown())})
export function exportPermission(user:AuthUser,report:string){
  const permission=report.startsWith('stock_')?'inventory.view':'reports.view'
  if(!user.permissions.includes('*')&&!user.permissions.includes(permission))throw new ForbiddenError()
}
export class ReportExportService {
  async list(user:AuthUser){
    const [rows]=await db.execute<RowDataPacket[]>(`SELECT id,report_type,format,status,row_count,snapshot_at,filename,error_message,expires_at FROM report_exports WHERE company_id=? AND user_id=? AND expires_at>NOW() ORDER BY created_at DESC LIMIT 20`,[user.companyId,user.id])
    return rows.filter(row=>user.permissions.includes('*')||user.permissions.includes(row.report_type.startsWith('stock_')?'inventory.view':'reports.view'))
  }
  async create(user:AuthUser,body:unknown){
    const input=exportSchema.parse(body);exportPermission(user,input.report)
    const filters=input.report==='general_ledger'?generalLedgerQuerySchema.parse(input.filters):input.report.startsWith('stock_')?inventoryCardQuerySchema.parse(input.filters):dateRangeQuerySchema.parse(input.filters)
    const id=crypto.randomUUID()
    const connection=await db.getConnection()
    try {
      await connection.beginTransaction()
      await connection.execute('SELECT id FROM users WHERE id=? AND company_id=? FOR UPDATE',[user.id,user.companyId])
      const [active]=await connection.execute<RowDataPacket[]>(`SELECT COUNT(*) amount FROM report_exports WHERE company_id=? AND user_id=? AND status IN('queued','processing') AND expires_at>NOW()`,[user.companyId,user.id])
      if(Number(active[0]!.amount)>=3)throw new ValidationError('Maksimal tiga ekspor aktif. Tunggu proses sebelumnya selesai.')
      await connection.execute(`INSERT INTO report_exports(id,company_id,user_id,report_type,format,filters_json,expires_at) VALUES(?,?,?,?,?,?,DATE_ADD(NOW(),INTERVAL 1 DAY))`,[id,user.companyId,user.id,input.report,input.format,JSON.stringify(filters)])
      await connection.commit()
    }catch(e){await connection.rollback();throw e}finally{connection.release()}
    return {id,status:'queued'}
  }
  async get(user:AuthUser,id:string,download=false){
    z.uuid().parse(id)
    const [rows]=await db.execute<RowDataPacket[]>(`SELECT id,report_type,status,row_count,snapshot_at,filename,error_message,expires_at${download?',output,format':''} FROM report_exports WHERE id=? AND company_id=? AND user_id=? AND expires_at>NOW()`,[id,user.companyId,user.id])
    if(!rows[0])throw new NotFoundError('Ekspor tidak ditemukan atau telah kedaluwarsa')
    exportPermission(user,rows[0].report_type)
    if(download&&rows[0].status!=='ready')throw new ValidationError('File belum siap diunduh')
    return rows[0]
  }
  async processNext(){
    const [jobs]=await db.execute<RowDataPacket[]>(`SELECT * FROM report_exports WHERE status='queued' AND expires_at>NOW() ORDER BY created_at LIMIT 1`)
    const job=jobs[0];if(!job)return
    const [claim]=await db.execute<ResultSetHeader>(`UPDATE report_exports SET status='processing' WHERE id=? AND status='queued'`,[job.id]);if(!claim.affectedRows)return
    let connection
    try{
      connection=await db.getConnection()
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT')
      const [companies]=await connection.execute<RowDataPacket[]>('SELECT name,base_currency,NOW() snapshot_at FROM companies WHERE id=?',[job.company_id])
      if(!companies[0])throw new Error('Company unavailable')
      const f=typeof job.filters_json==='string'?JSON.parse(job.filters_json):job.filters_json
      let rows:Record<string,unknown>[],columns:[string,string][],title:string
      if(job.report_type==='general_ledger'){
        title='Buku Besar';columns=[['journal_date','Tanggal'],['account_code','Nomor Akun'],['account_name','Nama COA'],['journal_number','Jurnal'],['combined_description','Keterangan / Referensi'],['report_currency','Mata Uang'],['debit','Debit'],['credit','Kredit'],['running_balance','Saldo D+ / K-']]
        const repository=new ReportRepository();rows=[]
        for(let page=1;;page++){
          const result=await repository.generalLedger(job.company_id,{dateFrom:f.date_from,dateTo:f.date_to,accountId:f.account_id,costCenterId:f.cost_center_id,projectId:f.project_id,reference:f.reference,page:String(page),limit:'200'},connection)
          if(result.total>100000)throw new ValidationError('Maksimal 100.000 baris; persempit rentang ekspor')
          rows.push(...result.rows.map(r=>({...r,journal_date:r.journal_date instanceof Date?r.journal_date.toISOString().slice(0,10):String(r.journal_date).slice(0,10),combined_description:[...new Set([r.description,r.reference].filter(Boolean))].join(' · ')})))
          if(rows.length>=result.total||!result.rows.length)break
        }
      }else if(job.report_type==='stock_card'){
        title='Kartu Mutasi Stok';columns=[['movement_date','Tanggal'],['transaction_number','Dokumen'],['sku','Kode Barang'],['item_name','Nama Barang'],['warehouse_name','Gudang'],['quantity_in','Masuk'],['quantity_out','Keluar'],['chronological_quantity','Saldo QTY'],['chronological_value','Saldo Nilai'],['report_currency','Mata Uang']]
        rows=[];const repository=new InventoryRepository()
        for(let page=1;;page++){
          const result=await repository.card(job.company_id,{itemId:f.item_id,itemIds:f.item_ids,warehouseId:f.warehouse_id,dateFrom:f.date_from,dateTo:f.date_to,search:f.search,page:String(page),limit:'200'},connection)
          if(result.total>100000)throw new ValidationError('Maksimal 100.000 baris; persempit rentang ekspor')
          rows.push(...result.rows.map(r=>({...r,report_currency:companies[0]!.base_currency,movement_date:r.movement_date instanceof Date?r.movement_date.toISOString().slice(0,10):String(r.movement_date).slice(0,10)})))
          if(rows.length>=result.total||!result.rows.length)break
        }
      }else if(!job.report_type.startsWith('stock_')){
        const financial=await financialExport(connection,job.company_id,job.report_type,f.date_from,f.date_to)
        title=financial.title;columns=financial.columns;rows=financial.rows.map(row=>({...row,report_currency:companies[0]!.base_currency}))
      }else{
        title='Ringkasan Mutasi Stok';columns=[['sku','Kode Barang'],['item_name','Nama Barang'],['warehouse_name','Gudang'],['opening_quantity','Saldo Awal'],['quantity_in','Masuk'],['quantity_out','Keluar'],['chronological_quantity','Saldo Akhir'],['unit_symbol','Satuan'],['chronological_value','Nilai Akhir'],['report_currency','Mata Uang']]
        rows=await new InventoryService().summary(job.company_id,f,connection)
        if(f.search)rows=rows.filter(r=>Object.values(r).join(' ').toLocaleLowerCase('id-ID').includes(String(f.search).toLocaleLowerCase('id-ID')))
      }
      if(rows.length>100000)throw new ValidationError('Maksimal 100.000 baris; persempit rentang ekspor')
      if(rows.some(r=>r.report_currency!==companies[0]!.base_currency))throw new ValidationError('Mata uang snapshot tidak konsisten')
      const snapshot:FileSnapshot={title,company:companies[0].name,currency:companies[0].base_currency,period:job.report_type==='balance_sheet'?`Per ${f.date_to}`:`${f.date_from} - ${f.date_to}`,columns,rows}
      const snapshotAt=companies[0].snapshot_at
      await connection.commit();connection.release();connection=undefined
      if(job.format==='pdf'&&rows.length>10000)throw new ValidationError('PDF maksimal 10.000 baris; gunakan CSV untuk laporan lebih besar')
      const output=job.format==='pdf'?await pdfFile(snapshot):csvFile(snapshot)
      if(output.length>64*1024*1024)throw new ValidationError('File melebihi 64 MB; persempit filter')
      await db.execute(`UPDATE report_exports SET status='ready',row_count=?,snapshot_at=?,filename=?,output=? WHERE id=? AND status='processing'`,[rows.length,snapshotAt,`${job.report_type}-${f.date_from}-${f.date_to}.${job.format}`,output,job.id])
    }catch(e){
      if(connection){await connection.rollback();connection.release()}
      await db.execute(`UPDATE report_exports SET status='failed',error_message=? WHERE id=? AND status='processing'`,[e instanceof ValidationError?e.message:'Ekspor gagal. Silakan coba kembali atau hubungi administrator.',job.id])
      console.error('Report export failed',job.id,e instanceof Error?e.name:'Unknown error')
    }
  }
}
let running=false
export function startReportExportWorker(){
  const service=new ReportExportService()
  const timer=setInterval(async()=>{
    if(running)return;running=true
    try{
      await db.execute(`DELETE FROM report_exports WHERE expires_at<NOW()`)
      await db.execute(`UPDATE report_exports SET status='failed',error_message='Proses terhenti. Buat ekspor baru.' WHERE status='processing' AND updated_at<DATE_SUB(NOW(),INTERVAL 30 MINUTE)`)
      await service.processNext()
    }catch{console.error('Report export worker unavailable')}finally{running=false}
  },2000)
  timer.unref()
  return timer
}
