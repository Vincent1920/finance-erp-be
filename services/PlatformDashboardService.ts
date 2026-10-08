import os from 'node:os'
import {statfs} from 'node:fs/promises'
import {db,transaction} from '../config/database'
import {env} from '../config/env'
import {NotFoundError} from '../utils/AppError'
let previousCpu=os.cpus()
function cpuUsage(){const current=os.cpus(),sum=(cpu:any)=>Object.values(cpu.times).reduce((a:number,v:any)=>a+Number(v),0);let total=0,idle=0;current.forEach((cpu,i)=>{const old=previousCpu[i];if(old){total+=sum(cpu)-sum(old);idle+=cpu.times.idle-old.times.idle}});previousCpu=current;return total>0?Math.round((1-idle/total)*1000)/10:null}
export function monitoredDatabases(){return [...new Set([env.DB_NAME,...(process.env.PLATFORM_MONITORED_DATABASES??'').split(',').map(s=>s.trim()).filter(s=>/^[A-Za-z0-9_]+$/.test(s))])].slice(0,50)}
export class PlatformDashboardService{
 async overview(search='',page=1){
  return transaction(async cx=>{
   const one=async(sql:string,params:any[]=[])=>{const [r]=await cx.query<any[]>(sql,params);return r[0]??{}}
   const summary=await one(`SELECT (SELECT COUNT(*) FROM companies) companies,(SELECT COUNT(*) FROM users WHERE deleted_at IS NULL) users,(SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND status='active') active_users,(SELECT COUNT(*) FROM journals WHERE status IN ('posted','reversed')) posted_journals,(SELECT COUNT(*) FROM auth_sessions WHERE revoked_at IS NULL AND expires_at>UTC_TIMESTAMP(3)) sessions_not_expired,(SELECT COUNT(*) FROM error_logs WHERE resolved_at IS NULL AND level='error') unresolved_errors,(SELECT COUNT(*) FROM report_exports WHERE status IN ('queued','processing')) pending_exports,(SELECT COUNT(*) FROM report_exports WHERE status='failed') failed_exports`)
   const like='%'+search.replace(/[\%_]/g,c=>'\\'+c)+'%'
   const total=await one('SELECT COUNT(*) total FROM companies WHERE name LIKE ? OR legal_name LIKE ?',[like,like])
   const [companies]=await cx.query<any[]>(`SELECT c.id,c.name,c.base_currency,c.created_at,(SELECT COUNT(*) FROM users u WHERE u.company_id=c.id AND u.deleted_at IS NULL) users,(SELECT COUNT(*) FROM journals j WHERE j.company_id=c.id) journals,(SELECT MAX(journal_date) FROM journals j WHERE j.company_id=c.id AND j.status IN ('posted','reversed')) latest_posting_date,(SELECT COUNT(*) FROM error_logs e WHERE e.company_id=c.id AND e.resolved_at IS NULL AND e.level='error') unresolved_errors,(SELECT MAX(completed_at) FROM backup_jobs b WHERE b.company_id=c.id AND b.status='completed') last_backup_job FROM companies c WHERE c.name LIKE ? OR c.legal_name LIKE ? ORDER BY c.id LIMIT 25 OFFSET ?`,[like,like,(page-1)*25])
   const names=monitoredDatabases(),marks=names.map(()=>'?').join(',')
   const [metadata]=await cx.query<any[]>(`SELECT s.SCHEMA_NAME name,COUNT(t.TABLE_NAME) tables,COALESCE(SUM(t.DATA_LENGTH+t.INDEX_LENGTH),0) size_bytes FROM information_schema.SCHEMATA s LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA=s.SCHEMA_NAME AND t.TABLE_TYPE='BASE TABLE' WHERE s.SCHEMA_NAME IN (${marks}) GROUP BY s.SCHEMA_NAME`,names)
   const databases=names.map(name=>({...metadata.find(r=>r.name===name),name,available:metadata.some(r=>r.name===name),current:name===env.DB_NAME}))
   const backups=await one("SELECT MAX(completed_at) latest_completed, SUM(status='failed') failed_jobs FROM backup_jobs")
   const hasMigrations=await one("SELECT COUNT(*) present FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='migrations'")
   const migration=hasMigrations.present?await one('SELECT COUNT(*) applied FROM migrations'):{applied:null}
   const disk=await statfs(process.cwd()).catch(()=>null)
   const metrics={cpu_usage_percent:cpuUsage(),cpu_count:os.cpus().length,cpu_load_average:process.platform==='win32'?null:os.loadavg(),memory_total_bytes:os.totalmem(),memory_available_bytes:os.freemem(),process_memory_bytes:process.memoryUsage().rss,disk_available_bytes:disk?Number(disk.bavail)*Number(disk.bsize):null,disk_total_bytes:disk?Number(disk.blocks)*Number(disk.bsize):null}
   const alerts:any[]=[]
   if(metrics.memory_available_bytes<metrics.memory_total_bytes*0.1)alerts.push({key:'memory-low',severity:'warning',message:'Memori tersedia kurang dari 10%'})
   if(Number(summary.unresolved_errors)>0)alerts.push({key:'errors:'+summary.unresolved_errors,severity:'warning',message:summary.unresolved_errors+' error belum diselesaikan'})
   if(Number(summary.failed_exports)>0)alerts.push({key:'exports:'+summary.failed_exports,severity:'warning',message:summary.failed_exports+' pekerjaan ekspor gagal'})
   if(!backups.latest_completed||Date.now()-new Date(backups.latest_completed).getTime()>7*86400000)alerts.push({key:'backup:'+String(backups.latest_completed??'missing'),severity:'warning',message:'Belum ada backup selesai dalam 7 hari terakhir'})
   if(disk&&metrics.disk_available_bytes!<metrics.disk_total_bytes!*0.1)alerts.push({key:'disk-low',severity:'critical',message:'Ruang disk server kurang dari 10%'})
   return {metrics,alerts,generated_at:new Date().toISOString(),database_connected:true,summary,companies,pagination:{page,limit:25,total:Number(total.total)},databases,backups,migration,uptime_seconds:Math.floor(process.uptime())}
  })
 }
 async company(id:number){
  const [rows]=await db.query<any[]>('SELECT id,name,base_currency,created_at FROM companies WHERE id=?',[id]);if(!rows[0])throw new NotFoundError('Perusahaan tidak ditemukan')
  const counts:any={}
  for(const table of ['users','accounts','journals','sales_invoices','purchase_invoices','inventory_movements','payroll_runs','bank_statements','report_exports']){
   const [r]=await db.query<any[]>(`SELECT COUNT(*) total FROM ${table} WHERE company_id=?`,[id]);counts[table]=Number(r[0].total)
  }
  const [errors]=await db.query<any[]>('SELECT id,level,category,created_at,resolved_at FROM error_logs WHERE company_id=? ORDER BY id DESC LIMIT 20',[id])
  return {company:rows[0],counts,errors}
 }
}
