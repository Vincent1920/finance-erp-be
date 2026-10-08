import assert from 'node:assert/strict'
import {db} from '../config/database'
import {PlatformCompanyService,provisionSchema,subscriptionSchema} from '../services/PlatformCompanyService'
import {CoaGovernanceService} from '../services/CoaGovernanceService'
import {AuthService} from '../services/AuthService'
import {AuthSessionService} from '../services/AuthSessionService'
import {MfaService} from '../services/MfaService'
import {assertUserQuota} from '../services/TenantAccessService'
import {SystemUserService} from '../services/SystemUserService'
import {totp} from '../utils/totp'
export async function verifyPlatformOperations(userId:number){
 assert.match(String(process.env.DB_NAME),/^finora_verify_\d+_\d+$/)
 const service=new PlatformCompanyService(),actor={id:userId,companyId:1}
 const input=provisionSchema.parse({request_key:crypto.randomUUID(),customer_name:'Verified tenant',company_name:'Verified Company',plan_code:'starter',industry:'services',currency:'USD',opening_date:'2026-10-01',admin_name:'Verified Company Admin',admin_email:'tenant-admin@platform.verify',admin_password:'OwnerVerify123'})
 const result=await service.provision(input,actor),companyId=result.company_id!
 assert.equal((await service.provision(input,actor)).company_id,companyId)
 const [accounts]=await db.query<any[]>('SELECT COUNT(*) n FROM accounts WHERE company_id=?',[companyId]);assert.ok(accounts[0].n>10)
 const governance=await new CoaGovernanceService().overview(companyId);assert.equal(governance.ready,true)
 const {ReportRepository}=await import('../repositories/ReportRepository')
 const {EntityRepository}=await import('../repositories/EntityRepository')
 const master=await new EntityRepository('accounts').list(companyId,{page:'1',limit:'200',sort:'presentation_order',order:'asc'})
 const assetRows=master.rows.filter((a:any)=>a.account_type==='asset'&&a.is_posting)
 assert.ok(assetRows.findIndex((a:any)=>a.code==='111001')<assetRows.findIndex((a:any)=>a.code==='113001'))
 assert.ok(assetRows.findIndex((a:any)=>a.code==='115001')<assetRows.findIndex((a:any)=>a.code==='121003'))
 const reportRows=await new ReportRepository().trialBalance(companyId,{dateFrom:'2026-10-01',dateTo:'2026-10-31'})
 assert.equal(reportRows[0]!.code,'111001')
 assert.ok(reportRows.findIndex((a:any)=>a.code==='121003')<reportRows.findIndex((a:any)=>a.code==='121103'))
 const auth=new AuthService(),login=await auth.login(input.admin_email,input.admin_password);assert.equal(Number(login.user.companyId),companyId);assert.equal(login.user.isPlatformOperator,false)
 assert.equal(login.user.roles.some(r=>r==='super-admin'),false)
 assert.equal(login.user.permissions.some(p=>p.startsWith('backups.')),false)
 const [before]=await db.query<any[]>('SELECT COUNT(*) n FROM companies')
 await assert.rejects(()=>service.provision({...input,request_key:crypto.randomUUID(),customer_name:'Must roll back'},actor))
 const [after]=await db.query<any[]>('SELECT COUNT(*) n FROM companies');assert.equal(after[0].n,before[0].n)
 await assert.rejects(()=>service.provision({...input,request_key:crypto.randomUUID(),customer_id:result.customer_id,admin_email:'another@platform.verify'},actor),/Kuota perusahaan/)
 const customer=(await service.customers('Verified tenant')).rows[0]
 await service.subscription(Number(customer.id),subscriptionSchema.parse({plan_code:'growth',status:'suspended',valid_until:null,version:customer.version,reason:'Verify suspension'}),actor)
 await assert.rejects(()=>auth.login(input.admin_email,input.admin_password),/ditangguhkan/)
 await assert.rejects(()=>service.subscription(Number(customer.id),subscriptionSchema.parse({plan_code:'starter',status:'active',valid_until:null,version:customer.version,reason:'Stale update'}),actor),/berubah/)
 await service.subscription(Number(customer.id),subscriptionSchema.parse({plan_code:'growth',status:'active',valid_until:null,version:customer.version+1,reason:'Restore verified access'}),actor)
 const second=await service.provision({...input,request_key:crypto.randomUUID(),customer_id:result.customer_id,company_name:'Second verified company',admin_email:'second@platform.verify'},actor);assert.notEqual(second.company_id,companyId)
 const concurrent=await Promise.allSettled(Array.from({length:4},(_,n)=>service.provision({...input,request_key:crypto.randomUUID(),customer_id:result.customer_id,company_name:'Concurrent Company '+n,admin_email:'concurrent'+n+'@platform.verify'},actor)))
 assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,3)
 const [quotaUsers]=await db.query<any[]>("SELECT COUNT(*) n FROM users u JOIN platform_companies c ON c.company_id=u.company_id WHERE c.customer_id=? AND u.status='active' AND u.deleted_at IS NULL",[result.customer_id])
 const [baseUser]=await db.query<any[]>('SELECT password FROM users WHERE id=?',[result.admin_id])
 for(let n=Number(quotaUsers[0].n);n<25;n++)await db.execute("INSERT INTO users(company_id,name,email,password,status) VALUES(?,?,?,?,'active')",[companyId,'Quota user '+n,'quota'+n+'@platform.verify',baseUser[0].password])
 const adminActor={id:Number(result.admin_id),companyId,roles:['company-admin-'+companyId]}
 const [adminRoles]=await db.query<any[]>('SELECT role_id FROM user_roles WHERE user_id=?',[result.admin_id])
 await assert.rejects(()=>new SystemUserService().create(adminActor,{name:'Over quota',email:'overquota@platform.verify',password:'OwnerVerify123',status:'active',role_ids:[Number(adminRoles[0].role_id)]}),/Kuota pengguna/)
 const mfa=new MfaService(),sessions=new AuthSessionService(),setup=await mfa.begin(Number(result.admin_id),input.admin_password)
 const current=Math.floor(Date.now()/30000),code=totp(setup.secret,current)
 const recovery=await mfa.finish(Number(result.admin_id),companyId,code)
 assert.equal(recovery.recovery_codes.length,8)
 const [secrets]=await db.query<any[]>('SELECT secret_cipher,recovery_hashes FROM auth_mfa WHERE user_id=?',[result.admin_id]);assert.equal(secrets[0].secret_cipher.includes(setup.secret),false)
 await assert.rejects(()=>sessions.validate(login.token,Number(result.admin_id),companyId))
 await assert.rejects(()=>auth.login(input.admin_email,input.admin_password),/MFA aktif/)
 await assert.rejects(()=>auth.login(input.admin_email,input.admin_password,{mfaCode:code}),/sudah digunakan/)
 const secured=await auth.login(input.admin_email,input.admin_password,{mfaCode:recovery.recovery_codes[0]});assert.equal(Number(secured.user.companyId),companyId)
 await assert.rejects(()=>auth.login(input.admin_email,input.admin_password,{mfaCode:recovery.recovery_codes[0]}),/sudah digunakan/)
 const [otherUsers]=await db.query<any[]>('SELECT COUNT(*) n FROM users WHERE company_id=1 AND email=?',[input.admin_email]);assert.equal(otherUsers[0].n,0)
 console.log('PASS Platform operations: atomic provisioning, idempotency, ready COA/mapping, company isolation, quota, subscription control, MFA encrypted secret, replay rejection, recovery and session revocation')
}
