import {db,transaction} from '../config/database'
import {AuditService} from './AuditService'
import {NotFoundError,ConflictError} from '../utils/AppError'
export type AlertKind='errors'|'exports'|'backup'|'disk'|'memory'
export function safeAlertMessage(value:unknown){return String(value??'').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[redacted token]').replace(/\b(password|token|secret|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,'$1=[redacted]').replace(/'[^']*'|"[^"]*"/g,'[redacted value]').slice(0,1000)}
export class PlatformAlertService{
 async list(kind:AlertKind,page=1,status='open'){
  const offset=(page-1)*25
  if(kind==='errors'){
   const where=status==='open'?"e.resolved_at IS NULL":status==='resolved'?"e.resolved_at IS NOT NULL":'1=1'
   const [rows]=await db.query<any[]>(`SELECT e.id,e.company_id,c.name company_name,e.level,e.category,e.error_code,e.message,e.path,e.method,e.created_at,e.resolved_at,e.resolution_notes FROM error_logs e LEFT JOIN companies c ON c.id=e.company_id WHERE e.level='error' AND ${where} ORDER BY e.id DESC LIMIT 25 OFFSET ?`,[offset])
   const [count]=await db.query<any[]>(`SELECT COUNT(*) total FROM error_logs e WHERE e.level='error' AND ${where}`)
   return {kind,title:'Error aplikasi',guidance:'Periksa penyebab, lakukan perbaikan, lalu tandai selesai dengan catatan. Menandai selesai tidak memperbaiki program secara otomatis.',rows:rows.map(r=>({...r,message:safeAlertMessage(r.message),path:String(r.path??'').split('?')[0].slice(0,500),resolution_notes:safeAlertMessage(r.resolution_notes)})),total:Number(count[0].total),page,limit:25}
  }
  if(kind==='exports'){
   const [rows]=await db.query<any[]>(`SELECT e.id,e.company_id,c.name company_name,e.report_type,e.format,e.status,e.created_at,e.error_message FROM report_exports e JOIN companies c ON c.id=e.company_id WHERE e.status='failed' ORDER BY e.created_at DESC,e.id DESC LIMIT 25 OFFSET ?`,[offset])
   const [count]=await db.query<any[]>("SELECT COUNT(*) total FROM report_exports WHERE status='failed'")
   return {kind,title:'Ekspor gagal',guidance:'Periksa filter, batas ukuran laporan, dan layanan worker. Buat ulang ekspor dari perusahaan terkait setelah penyebab diperbaiki.',rows:rows.map(r=>({...r,message:safeAlertMessage(r.error_message)})),total:Number(count[0].total),page,limit:25}
  }
  if(kind==='backup'){
   const [rows]=await db.query<any[]>(`SELECT b.id,b.company_id,c.name company_name,b.backup_number,b.type,b.status,b.created_at,b.completed_at,b.error_message FROM backup_jobs b JOIN companies c ON c.id=b.company_id ORDER BY b.id DESC LIMIT 25 OFFSET ?`,[offset]);const [count]=await db.query<any[]>('SELECT COUNT(*) total FROM backup_jobs')
   return {kind,title:'Pekerjaan backup',guidance:'Backup mencakup database platform. Periksa keberadaan file dan lakukan uji pemulihan terpisah; status completed bukan jaminan restore berhasil.',rows:rows.map(r=>({...r,message:safeAlertMessage(r.error_message)})),total:Number(count[0].total),page,limit:25}
  }
  return {kind,title:kind==='disk'?'Ruang disk server':'Memori server',guidance:kind==='disk'?'Periksa volume tempat API berjalan dan penggunaan file/log. Jangan menghapus database atau file backup tanpa prosedur retensi.':'Periksa proses yang memakai memori dan pekerjaan ekspor bersamaan. Metrik berada pada panel Kesehatan server; gunakan Perbarui data untuk pengukuran baru.',rows:[],total:0,page,limit:25}
 }
 async resolve(id:number,note:string,actor:{id:number;companyId:number}){
  return transaction(async cx=>{
   const [rows]=await cx.query<any[]>('SELECT id,company_id,resolved_at FROM error_logs WHERE id=? FOR UPDATE',[id]);if(!rows[0])throw new NotFoundError('Error tidak ditemukan');if(rows[0].resolved_at)throw new ConflictError('Error ini sudah ditandai selesai. Muat ulang daftar.')
   await cx.execute('UPDATE error_logs SET resolved_at=NOW(),resolved_by=?,resolution_notes=? WHERE id=?',[actor.id,note,id])
   await new AuditService().log(cx,{companyId:actor.companyId,userId:actor.id,module:'platform',action:'resolve_error',recordType:'error_log',recordId:id,newValue:{errorCompanyId:rows[0].company_id,note}})
   return {saved:true}
  })
 }
}
