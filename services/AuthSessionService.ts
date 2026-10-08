import {createHash} from 'node:crypto'
import jwt from 'jsonwebtoken'
import {db,transaction} from '../config/database'
import {UnauthorizedError,NotFoundError} from '../utils/AppError'
import {AuditService} from './AuditService'
const hash=(token:string)=>createHash('sha256').update(token).digest('hex')
export async function securityNumber(companyId:number,key:string,fallback:number,min:number,max:number){
 const [r]=await db.query<any[]>('SELECT setting_value FROM settings WHERE company_id=? AND setting_key=?',[companyId,key])
 const n=Number(r[0]?.setting_value??fallback);return Number.isFinite(n)&&n>=min&&n<=max?Math.floor(n):fallback
}
export class AuthSessionService{
 async register(token:string,userId:number,companyId:number,device='',expectedPassword?:string,mfaVerified=false){
  const claims=jwt.decode(token) as {exp?:number}|null
  if(!claims?.exp)throw new UnauthorizedError()
  const id=crypto.randomUUID()
  const [created]=await db.execute<any>("INSERT INTO auth_sessions(id,company_id,user_id,token_hash,device_label,expires_at,created_at,last_seen_at) SELECT ?,?,?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3) FROM users WHERE id=? AND company_id=? AND status='active' AND deleted_at IS NULL AND (? IS NULL OR password=?) AND (?=TRUE OR NOT EXISTS(SELECT 1 FROM auth_mfa m WHERE m.user_id=users.id AND m.enabled=TRUE))",[id,companyId,userId,hash(token),device.slice(0,255),new Date(claims.exp*1000),userId,companyId,expectedPassword??null,expectedPassword??null,mfaVerified])
  if(!created.affectedRows)throw new UnauthorizedError('Akses berubah. Silakan login kembali.')
  return id
 }
 async validate(token:string,userId:number,companyId:number){
  const idle=await securityNumber(companyId,'security.session_timeout_minutes',480,1,10080)
  return transaction(async cx=>{
   const [r]=await cx.query<any[]>(`SELECT s.id FROM auth_sessions s JOIN users u ON u.id=s.user_id AND u.company_id=s.company_id WHERE s.token_hash=? AND s.user_id=? AND s.company_id=? AND s.revoked_at IS NULL AND s.expires_at>UTC_TIMESTAMP(3) AND s.last_seen_at>DATE_SUB(UTC_TIMESTAMP(3),INTERVAL ? MINUTE) FOR UPDATE`,[hash(token),userId,companyId,idle])
   if(!r[0])throw new UnauthorizedError('Sesi telah berakhir atau dicabut. Silakan login kembali.')
   await cx.execute('UPDATE auth_sessions SET last_seen_at=UTC_TIMESTAMP(3) WHERE id=?',[r[0].id]);return r[0].id as string
  })
 }
 async list(userId:number,companyId:number,current:string){
  const idle=await securityNumber(companyId,'security.session_timeout_minutes',480,1,10080)
  const [rows]=await db.query<any[]>('SELECT id,device_label,created_at,last_seen_at,expires_at FROM auth_sessions WHERE user_id=? AND company_id=? AND revoked_at IS NULL AND expires_at>UTC_TIMESTAMP(3) AND last_seen_at>DATE_SUB(UTC_TIMESTAMP(3),INTERVAL ? MINUTE) ORDER BY last_seen_at DESC LIMIT 100',[userId,companyId,idle])
  return rows.map(r=>({...r,current:r.id===current}))
 }
 async revoke(userId:number,companyId:number,id:string,all=false){
  return transaction(async cx=>{
   const [result]=await cx.execute<any>(`UPDATE auth_sessions SET revoked_at=UTC_TIMESTAMP(3) WHERE company_id=? AND user_id=? ${all?'':'AND id=?'} AND revoked_at IS NULL`,all?[companyId,userId]:[companyId,userId,id])
   if(!all&&!result.affectedRows)throw new NotFoundError('Sesi tidak ditemukan atau sudah ditutup')
   await new AuditService().log(cx,{companyId,userId,module:'auth',action:all?'sessions_revoke_all':'session_revoke',recordType:'user',recordId:userId,newValue:{sessionId:all?null:id}})
  })
 }
}
