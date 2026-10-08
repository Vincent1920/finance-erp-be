import assert from 'node:assert/strict'
import {db} from '../config/database'
import {PlatformCompanyService,provisionSchema} from '../services/PlatformCompanyService'
import {AuthSessionService} from '../services/AuthSessionService'
import {signToken} from '../utils/token'
import {csrfValue} from '../utils/auth-cookie'
import {env} from '../config/env'
import {totp} from '../utils/totp'
export async function verifySecurityBoundary(userId:number){
 assert.match(String(process.env.DB_NAME),/^finora_verify_\d+_\d+$/)
 const oldOperators=process.env.PLATFORM_OPERATOR_USER_IDS
 process.env.PLATFORM_OPERATOR_USER_IDS=''
 try{
 await db.execute('UPDATE auth_login_limits SET reset_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 SECOND)')
 const {app}=await import('../app')
 const input=provisionSchema.parse({request_key:crypto.randomUUID(),customer_name:'Isolation A',company_name:'Isolated Company A',currency:'IDR',industry:'trading',opening_date:'2026-10-01',admin_name:'Isolation admin A',admin_email:'isolation-a@verify.local',admin_password:'IsolationPass123'})
 const a=await new PlatformCompanyService().provision(input,{id:userId,companyId:1})
 const bToken=signToken({id:userId,companyId:1});await new AuthSessionService().register(bToken,userId,1)
 const login=async(extra:any={})=>app.request('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Auth-Transport':'cookie',Origin:env.FRONTEND_URL},body:JSON.stringify({email:input.admin_email,password:input.admin_password,...extra})})
 const issued=await login();assert.equal(issued.status,200);assert.equal((await issued.clone().json() as any).data.token,undefined)
 const set=issued.headers.getSetCookie();assert.ok(set.some(v=>v.includes('HttpOnly')&&v.includes('SameSite=Strict')&&v.includes('Path=/api')))
 let cookie=set.map(v=>v.split(';')[0]).join('; '),csrf=decodeURIComponent(set.find(v=>v.startsWith('finora_csrf='))!.split(';')[0]!.split('=')[1]!)
 const req=(path:string,method='GET',body?:any,overrides:any={})=>app.request('/api'+path,{method,headers:{Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json',Origin:env.FRONTEND_URL,...overrides},body:body===undefined?undefined:JSON.stringify(body)})
 assert.equal((await req('/auth/me')).status,200);assert.equal((await req('/auth/me')).status,200)
 assert.equal((await req('/preferences/interface-language','PUT',['en-US'],{'X-CSRF-Token':''})).status,403)
 assert.equal((await req('/preferences/interface-language','PUT',['en-US'],{Origin:'https://untrusted.invalid'})).status,403)
 assert.equal((await req('/preferences/interface-language','PUT',['en-US'])).status,200)
 const endpoints=[['accounts','accounts'],['customers','customers'],['suppliers','suppliers'],['items','items'],['bank-accounts','bank_accounts'],['users','users'],['journals','journals'],['sales/invoices','sales_invoices'],['purchases/invoices','purchase_invoices'],['payroll/runs','payroll_runs'],['operations/budgets','budgets']]
 let detailChecks=0
 for(const [path,table] of endpoints){const [rows]=await db.query<any[]>(`SELECT id FROM ${table} WHERE company_id=1 ORDER BY id LIMIT 1`);if(!rows[0])continue;const result=await req('/'+path+'/'+rows[0].id+(path==='operations/budgets'?'?as_of_date=2026-10-08':''));assert.ok([403,404].includes(result.status),path+' foreign detail status '+result.status);detailChecks++}
 assert.ok(detailChecks>=9)
 const [foreignAccount]=await db.query<any[]>('SELECT id FROM accounts WHERE company_id=1 LIMIT 1')
 assert.equal((await req('/accounts/'+foreignAccount[0].id,'PUT',{name:'Foreign edit rejected'})).status,404)
 const [foreignInvoice]=await db.query<any[]>('SELECT id FROM sales_invoices WHERE company_id=1 LIMIT 1')
 assert.equal((await req('/sales/invoices/'+foreignInvoice[0].id+'/cancel','POST',{reason:'Foreign cancel rejected'})).status,404)
 const list:any=await (await req('/accounts?limit=100&company_id=1')).json();assert.ok(list.data.every((r:any)=>Number(r.company_id)===a.company_id))
 const ledgerResponse=await req('/reports/general-ledger?date_from=2026-01-01&date_to=2026-12-31&account_id='+foreignAccount[0].id);assert.equal(ledgerResponse.status,200);const ledger:any=await ledgerResponse.json();assert.deepEqual(ledger.data,[])
 assert.equal((await req('/operations/backups')).status,403)
 assert.equal((await req('/platform/overview')).status,403)
 const [owned]=await db.query<any[]>('SELECT id FROM accounts WHERE company_id=? LIMIT 1',[a.company_id])
 assert.equal((await app.request('/api/accounts/'+owned[0].id,{headers:{Authorization:'Bearer '+bToken}})).status,404)
 const exportResponse=await req('/exports','POST',{report:'trial_balance',format:'csv',filters:{date_from:'2026-10-01',date_to:'2026-10-31'}});assert.equal(exportResponse.status,202)
 const job=(await exportResponse.json() as any).data
 const {ReportExportService}=await import('../services/ReportExportService');await new ReportExportService().processNext()
 assert.equal((await app.request('/api/exports/'+job.id,{headers:{Authorization:'Bearer '+bToken}})).status,404)
 assert.equal((await app.request('/api/exports/'+job.id+'/download',{headers:{Authorization:'Bearer '+bToken}})).status,404)
 // Positive search controls: B can find its document while A sees none, even with spoofed company_id.
 const [searchDoc]=await db.query<any[]>('SELECT journal_number FROM journals WHERE company_id=1 ORDER BY id LIMIT 1')
 const searchTerm=encodeURIComponent(searchDoc[0].journal_number)
 for(const path of ['/global-search?q=','/transactions?search=']){
  const ownResponse=await app.request('/api'+path+searchTerm,{headers:{Authorization:'Bearer '+bToken}})
  assert.equal(ownResponse.status,200);assert.ok((await ownResponse.json() as any).data.length>0)
  const foreignResponse=await req(path+searchTerm+'&company_id=1');assert.equal(foreignResponse.status,200)
  assert.deepEqual((await foreignResponse.json() as any).data,[])
 }
 // Stage a real preview through the public multipart route; do not confirm business data.
 const form=new FormData();form.set('import_type','customer');form.set('file',new File(['customer_code,customer_name,tax_number\nISO-A,Isolation customer,1234567890123456\n'],'isolation.csv',{type:'text/csv'}))
 const previewResponse=await app.request('/api/imports/preview',{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':csrf,Origin:env.FRONTEND_URL},body:form})
 assert.equal(previewResponse.status,201);const preview=(await previewResponse.json() as any).data.job
 assert.equal((await req('/imports/'+preview.id)).status,200)
 for(const [suffix,method,body] of [['','GET',undefined],['/rows','GET',undefined],['/errors?format=csv','GET',undefined],['/confirm','POST',{import_as:'draft',error_policy:'all_or_nothing'}],['/cancel','POST',undefined]] as const){
  const r=await app.request('/api/imports/'+preview.id+suffix,{method,headers:{Authorization:'Bearer '+bToken,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined})
  assert.equal(r.status,404,'foreign import '+suffix)
 }
 const [attachment]=await db.execute<any>(`INSERT INTO attachments(company_id,entity_type,entity_id,file_name,original_name,mime_type,file_size,storage_path,checksum,uploaded_by) VALUES(1,'accounting_schedule_entry',1,'isolation.txt','isolation.txt','text/plain',1,'storage/attachments/1/isolation.txt','test',?)`,[userId])
 for(const method of ['GET','DELETE'])assert.equal((await req('/accounting-schedules/attachments/'+attachment.insertId+(method==='GET'?'/download':''),method)).status,404)
 const {AccountingScheduleService}=await import('../services/AccountingScheduleService')
 assert.equal((await new AccountingScheduleService().attachment(1,attachment.insertId)).original_name,'isolation.txt')
 const [limited]=await db.execute<any>(`INSERT INTO users(company_id,name,email,password,status) SELECT ?,'Limited access verifier','limited@verify.local',password,'active' FROM users WHERE id=?`,[a.company_id,userId])
 const limitedToken=signToken({id:limited.insertId,companyId:a.company_id});await new AuthSessionService().register(limitedToken,limited.insertId,a.company_id)
 for(const path of ['/accounts','/roles','/users','/global-search?q=ISO','/imports','/accounting-schedules/attachments/'+attachment.insertId+'/download','/platform/overview'])assert.equal((await app.request('/api'+path,{headers:{Authorization:'Bearer '+limitedToken}})).status,403,'permission denied '+path)
 const emptyExports=await app.request('/api/exports',{headers:{Authorization:'Bearer '+limitedToken}});assert.equal(emptyExports.status,200);assert.deepEqual((await emptyExports.json() as any).data,[])
 assert.equal((await app.request('/api/exports',{method:'POST',headers:{Authorization:'Bearer '+limitedToken,'Content-Type':'application/json'},body:JSON.stringify({report:'trial_balance',format:'csv',filters:{date_from:'2026-10-01',date_to:'2026-10-31'}})})).status,403)
 console.log('PASS Extended boundary: positive search controls, company spoofing, multipart preview, foreign import details/rows/error download/confirm/cancel, attachment metadata/download/delete and restricted-user endpoints')
 assert.equal((await req('/auth/logout','POST')).status,200);assert.equal((await req('/auth/me')).status,401)
 const relogin=await login();const cookies=relogin.headers.getSetCookie();cookie=cookies.map(v=>v.split(';')[0]).join('; ');csrf=cookies.find(v=>v.startsWith('finora_csrf='))!.split(';')[0]!.split('=')[1]!
 process.env.PLATFORM_OPERATOR_USER_IDS=String(a.admin_id)
 const begin=await req('/platform/mfa/setup','POST',{password:input.admin_password});assert.equal(begin.status,200);const setup=(await begin.json() as any).data
 const confirm=await req('/platform/mfa/confirm','POST',{code:totp(setup.secret,Math.floor(Date.now()/30000))});assert.equal(confirm.status,200);const codes=(await confirm.json() as any).data.recovery_codes
 assert.equal((await req('/auth/me')).status,401);assert.equal((await login()).status,401)
 const secured=await login({mfa_code:codes[0]});assert.equal(secured.status,200);assert.equal((await login({mfa_code:codes[0]})).status,401)
 console.log('PASS Cookie/MFA: HttpOnly, SameSite, hidden token, refresh, CSRF, origin, logout invalidation, activation revocation and one-use recovery')
 console.log('PASS Tenant boundary: '+detailChecks+' module details, master spoofing, foreign mutation, invoice cancel, reports, backup/platform denial and export metadata/download isolation')
 }finally{if(oldOperators===undefined)delete process.env.PLATFORM_OPERATOR_USER_IDS;else process.env.PLATFORM_OPERATOR_USER_IDS=oldOperators}
}
