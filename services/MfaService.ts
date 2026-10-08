import {createCipheriv,createDecipheriv,createHash,randomBytes,timingSafeEqual} from 'node:crypto'
import {db,transaction} from '../config/database'
import {verifyPassword} from '../utils/password'
import {base32,verifyTotp} from '../utils/totp'
import {AppError,ConflictError} from '../utils/AppError'
import {AuditService} from './AuditService'
const key=()=>{const value=process.env.MFA_ENCRYPTION_KEY;if(!value||! /^[a-f0-9]{64}$/i.test(value))throw new AppError('Kunci MFA belum dikonfigurasi operator',503);return Buffer.from(value,'hex')}
const encrypt=(secret:string)=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(),iv),data=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64')}
const decrypt=(value:string)=>{const data=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',key(),data.subarray(0,12));cipher.setAuthTag(data.subarray(12,28));return Buffer.concat([cipher.update(data.subarray(28)),cipher.final()]).toString('utf8')}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex')
export class MfaService{
 async status(id:number){const [r]=await db.query<any[]>('SELECT enabled FROM auth_mfa WHERE user_id=?',[id]);return {enabled:Boolean(r[0]?.enabled),configured:Boolean(process.env.MFA_ENCRYPTION_KEY)}}
 async begin(id:number,password:string){
  const [u]=await db.query<any[]>('SELECT password,email FROM users WHERE id=?',[id]);if(!u[0]||!await verifyPassword(password,u[0].password))throw new AppError('Password tidak sesuai',401)
  const secret=base32(randomBytes(20))
  await transaction(async cx=>{await cx.execute('INSERT IGNORE INTO auth_mfa(user_id) VALUES(?)',[id]);const [r]=await cx.query<any[]>('SELECT enabled FROM auth_mfa WHERE user_id=? FOR UPDATE',[id]);if(r[0].enabled)throw new ConflictError('MFA sudah aktif');await cx.execute('UPDATE auth_mfa SET pending_cipher=?,pending_until=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 10 MINUTE),failed_attempts=0,blocked_until=NULL WHERE user_id=?',[encrypt(secret),id])})
  return {secret,account:u[0].email,expires_in_minutes:10}
 }
 async finish(id:number,companyId:number,code:string){
  const result=await transaction(async cx=>{
   const [r]=await cx.query<any[]>('SELECT *,pending_until>UTC_TIMESTAMP() pending_valid,blocked_until>UTC_TIMESTAMP() blocked FROM auth_mfa WHERE user_id=? FOR UPDATE',[id]);const m=r[0]
   if(!m||m.enabled||!m.pending_valid||!m.pending_cipher)throw new ConflictError('Penyiapan MFA tidak tersedia atau kedaluwarsa')
   if(m.blocked)throw new AppError('Tunggu 15 menit sebelum mencoba MFA lagi',429)
   const counter=verifyTotp(decrypt(m.pending_cipher),code)
   if(counter===null){await cx.execute('UPDATE auth_mfa SET failed_attempts=failed_attempts+1,blocked_until=IF(failed_attempts>=5,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 15 MINUTE),NULL) WHERE user_id=?',[id]);return null}
   const recovery=Array.from({length:8},()=>randomBytes(10).toString('hex'))
   await cx.execute('UPDATE auth_mfa SET secret_cipher=pending_cipher,pending_cipher=NULL,pending_until=NULL,enabled=TRUE,last_counter=?,failed_attempts=0,blocked_until=NULL,recovery_hashes=? WHERE user_id=?',[counter,JSON.stringify(recovery.map(digest)),id])
   await cx.execute('UPDATE auth_sessions SET revoked_at=UTC_TIMESTAMP(3) WHERE user_id=? AND revoked_at IS NULL',[id])
   await new AuditService().log(cx,{companyId,userId:id,module:'auth',action:'mfa_enable',recordType:'user',recordId:id})
   return recovery
  });if(!result)throw new AppError('Kode authenticator tidak valid',401);return {recovery_codes:result}
 }
 async verifyLogin(id:number,code?:string){
  const valid=await transaction(async cx=>{
   const [r]=await cx.query<any[]>('SELECT *,blocked_until>UTC_TIMESTAMP() blocked FROM auth_mfa WHERE user_id=? FOR UPDATE',[id]);const m=r[0];if(!m?.enabled)return 'disabled'
   if(m.blocked)throw new AppError('Terlalu banyak kode MFA salah. Tunggu 15 menit.',429)
   if(!code)throw new AppError('MFA aktif. Masukkan kode authenticator atau kode pemulihan.',401)
   let counter=verifyTotp(decrypt(m.secret_cipher),code,Number(m.last_counter)),recovery=typeof m.recovery_hashes==='string'?JSON.parse(m.recovery_hashes):m.recovery_hashes??[]
   const index=recovery.findIndex((hash:string)=>timingSafeEqual(Buffer.from(hash,'hex'),Buffer.from(digest(code),'hex')))
   if(counter===null&&index<0){await cx.execute('UPDATE auth_mfa SET failed_attempts=failed_attempts+1,blocked_until=IF(failed_attempts>=5,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 15 MINUTE),NULL) WHERE user_id=?',[id]);return false}
   if(index>=0)recovery.splice(index,1)
   await cx.execute('UPDATE auth_mfa SET last_counter=?,recovery_hashes=?,failed_attempts=0,blocked_until=NULL WHERE user_id=?',[counter??m.last_counter,JSON.stringify(recovery),id]);return 'verified'
  });if(!valid)throw new AppError('Kode MFA tidak valid atau sudah digunakan',401);return valid==='verified'
 }
}
