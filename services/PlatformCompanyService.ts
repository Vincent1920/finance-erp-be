import {z} from 'zod'
import {db,transaction} from '../config/database'
import {defaults} from '../database/migrations/026_company_policy_settings'
import {hashPassword} from '../utils/password'
import {createUserSchema} from '../validators/system.validator'
import {SystemUserRepository} from '../repositories/SystemUserRepository'
import {CoaGovernanceService} from './CoaGovernanceService'
import {AuditService} from './AuditService'
import {ConflictError,NotFoundError} from '../utils/AppError'
export const provisionSchema=z.object({request_key:z.uuid(),customer_id:z.coerce.number().int().positive().nullable().optional(),customer_name:z.string().trim().min(2).max(191),plan_code:z.enum(['starter','growth','enterprise']).default('starter'),company_name:z.string().trim().min(2).max(191),currency:z.enum(['IDR','USD','EUR','SGD','CNY']).default('IDR'),industry:z.enum(['trading','services','manufacturing']).default('trading'),opening_date:z.iso.date(),admin_name:z.string().trim().min(2).max(191),admin_email:z.email().transform(s=>s.toLowerCase()),admin_password:z.string().min(8).max(128)})
export const subscriptionSchema=z.object({plan_code:z.enum(['starter','growth','enterprise','legacy']),status:z.enum(['trial','active','suspended']),valid_until:z.iso.date().nullable(),reason:z.string().trim().min(5).max(500),version:z.number().int().positive()}).refine(v=>v.status!=='trial'||Boolean(v.valid_until),{message:'Trial harus memiliki tanggal akhir',path:['valid_until']})
export class PlatformCompanyService{
 async customers(search='',page=1){const like='%'+search+'%';const [r]=await db.query<any[]>(`SELECT c.*,p.name plan_name,p.max_companies,p.max_users,(SELECT COUNT(*) FROM platform_companies x WHERE x.customer_id=c.id) companies FROM platform_customers c JOIN platform_plans p ON p.code=c.plan_code WHERE c.name LIKE ? ORDER BY c.id DESC LIMIT 25 OFFSET ?`,[like,(page-1)*25]);const [total]=await db.query<any[]>('SELECT COUNT(*) n FROM platform_customers WHERE name LIKE ?',[like]);return {rows:r,total:Number(total[0].n),page,limit:25}}

 async provision(input:z.infer<typeof provisionSchema>,actor:{id:number;companyId:number}){
  const admin=createUserSchema.parse({name:input.admin_name,email:input.admin_email,password:input.admin_password,status:'active',role_ids:[1]})
  const password=await hashPassword(admin.password)
  return transaction(async cx=>{
   const [prior]=await cx.query<any[]>('SELECT company_id,created_by FROM platform_companies WHERE provision_key=?',[input.request_key])
   if(prior[0]){if(Number(prior[0].created_by)!==actor.id)throw new ConflictError('Kunci permintaan telah digunakan');return {company_id:Number(prior[0].company_id),replayed:true}}
   let customerId=input.customer_id
   if(!customerId){const [r]=await cx.execute<any>("INSERT INTO platform_customers(name,plan_code,status,valid_until) VALUES(?,?,'trial',DATE_ADD(UTC_DATE(),INTERVAL 14 DAY))",[input.customer_name,input.plan_code]);customerId=Number(r.insertId)}
   const [customers]=await cx.query<any[]>(`SELECT c.*,p.max_companies,p.max_users FROM platform_customers c JOIN platform_plans p ON p.code=c.plan_code WHERE c.id=? FOR UPDATE`,[customerId])
   const customer=customers[0];if(!customer)throw new NotFoundError('Pelanggan tidak ditemukan')
   if(customer.status==='suspended'||(customer.valid_until&&new Date(customer.valid_until).toISOString().slice(0,10)<new Date().toISOString().slice(0,10)))throw new ConflictError('Pelanggan sedang ditangguhkan')
   const [counts]=await cx.query<any[]>('SELECT COUNT(*) n FROM platform_companies WHERE customer_id=? FOR UPDATE',[customerId]);if(Number(counts[0].n)>=customer.max_companies)throw new ConflictError('Kuota perusahaan paket telah tercapai')
   const [users]=await cx.query<any[]>("SELECT COUNT(*) n FROM users u JOIN platform_companies p ON p.company_id=u.company_id WHERE p.customer_id=? AND u.deleted_at IS NULL AND u.status='active' FOR UPDATE",[customerId]);if(Number(users[0].n)>=customer.max_users)throw new ConflictError('Kuota pengguna aktif telah tercapai')
   const [c]=await cx.execute<any>('INSERT INTO companies(name,legal_name,base_currency) VALUES(?,?,?)',[input.company_name,input.company_name,input.currency]);const companyId=Number(c.insertId)
   await cx.execute('INSERT INTO platform_companies(company_id,customer_id,industry,opening_date,provision_key,created_by) VALUES(?,?,?,?,?,?)',[companyId,customerId,input.industry,input.opening_date,input.request_key,actor.id])
   for(const setting of defaults)await cx.execute('INSERT INTO settings(company_id,setting_key,setting_value,value_type,category,is_secret) VALUES(?,?,?,?,?,FALSE)',[companyId,setting.key,String(setting.value),setting.type,setting.category])
   const year=Number(input.opening_date.slice(0,4)),month=Number(input.opening_date.slice(5,7));const last=new Date(Date.UTC(year,month,0)).toISOString().slice(0,10)
   await cx.execute("INSERT INTO accounting_periods(company_id,year,month,start_date,end_date,status) VALUES(?,?,?,?,?,'open')",[companyId,year,month,input.opening_date.slice(0,8)+'01',last])
   await new CoaGovernanceService().installTemplateInTransaction(cx,{id:actor.id,companyId,roles:['super-admin']},input.industry)
   const [role]=await cx.execute<any>('INSERT INTO roles(company_id,name,slug,is_active) VALUES(?,?,?,TRUE)',[companyId,'Admin Perusahaan','company-admin-'+companyId]);const roleId=Number(role.insertId)
   await cx.execute("INSERT INTO role_permissions(role_id,permission_id) SELECT ?,id FROM permissions WHERE slug NOT LIKE 'backups.%'",[roleId])
   const repo=new SystemUserRepository(),uid=await repo.create(companyId,{name:admin.name,email:admin.email,password,status:'active'},actor.id,cx);await repo.assignRoles(uid,[roleId],cx)
   await new AuditService().log(cx,{companyId:actor.companyId,userId:actor.id,module:'platform',action:'provision_company',recordType:'company',recordId:companyId,newValue:{customerId,industry:input.industry,adminId:uid}})
   return {company_id:companyId,customer_id:customerId,admin_id:uid,replayed:false}
  })
 }
 async subscription(id:number,input:z.infer<typeof subscriptionSchema>,actor:{id:number;companyId:number}){
  return transaction(async cx=>{
   const [r]=await cx.query<any[]>('SELECT * FROM platform_customers WHERE id=? FOR UPDATE',[id]);if(!r[0])throw new NotFoundError('Pelanggan tidak ditemukan');if(Number(r[0].version)!==input.version)throw new ConflictError('Data berubah. Muat ulang dahulu.')
   const [quota]=await cx.query<any[]>(`SELECT p.*,(SELECT COUNT(*) FROM platform_companies WHERE customer_id=?) companies,(SELECT COUNT(*) FROM users u JOIN platform_companies c ON c.company_id=u.company_id WHERE c.customer_id=? AND u.status='active' AND u.deleted_at IS NULL) users FROM platform_plans p WHERE code=?`,[id,id,input.plan_code]);if(quota[0].companies>quota[0].max_companies||quota[0].users>quota[0].max_users)throw new ConflictError('Paket baru tidak cukup untuk jumlah perusahaan/pengguna saat ini')
   await cx.execute('UPDATE platform_customers SET plan_code=?,status=?,valid_until=?,version=version+1 WHERE id=?',[input.plan_code,input.status,input.valid_until,id])
   await new AuditService().log(cx,{companyId:actor.companyId,userId:actor.id,module:'platform',action:'subscription_update',recordType:'platform_customer',recordId:id,oldValue:r[0],newValue:input});return {saved:true}
  })
 }
}
