import {PlatformAlertService} from '../services/PlatformAlertService'
import {db} from '../config/database'
import {MfaService} from '../services/MfaService'
import {loginRateLimit} from '../middleware/login-rate-limit.middleware'
import {PlatformCompanyService,provisionSchema,subscriptionSchema} from '../services/PlatformCompanyService'
import {Hono} from 'hono'
import {z} from 'zod'
import type {AppBindings} from '../types/hono'
import {requirePlatformOperator} from '../middleware/role.middleware'
import {PlatformDashboardService} from '../services/PlatformDashboardService'
import {AuditService} from '../services/AuditService'
import {ok} from '../utils/response'
const route=new Hono<AppBindings>(),service=new PlatformDashboardService()
route.use('*',requirePlatformOperator)
route.get('/overview',async c=>{
 const input=z.object({search:z.string().trim().max(100).default(''),page:z.coerce.number().int().min(1).max(100000).default(1)}).parse(c.req.query())
 const data=await service.overview(input.search,input.page)
 const [acks]=await db.query<any[]>('SELECT alert_key FROM platform_alert_acknowledgements WHERE user_id=?',[c.get('user').id])
 data.alerts=data.alerts.map(a=>({...a,acknowledged:acks.some(r=>r.alert_key===a.key)}))
 await new AuditService().log(undefined,{companyId:c.get('user').companyId,userId:c.get('user').id,module:'platform',action:'dashboard_view',recordType:'platform',newValue:{page:input.page}})
 return ok(c,data)
})
route.get('/companies/:id',async c=>{
 const id=z.coerce.number().int().positive().parse(c.req.param('id')),data=await service.company(id)
 await new AuditService().log(undefined,{companyId:c.get('user').companyId,userId:c.get('user').id,module:'platform',action:'company_monitor_view',recordType:'company',recordId:id})
 return ok(c,data)
})
route.get('/customers',async c=>{const q=z.object({search:z.string().max(100).default(''),page:z.coerce.number().int().min(1).max(100000).default(1)}).parse(c.req.query());return ok(c,await new PlatformCompanyService().customers(q.search,q.page))})
route.post('/companies',async c=>ok(c,await new PlatformCompanyService().provision(provisionSchema.parse(await c.req.json()),c.get('user'))))
route.put('/customers/:id/subscription',async c=>ok(c,await new PlatformCompanyService().subscription(z.coerce.number().int().positive().parse(c.req.param('id')),subscriptionSchema.parse(await c.req.json()),c.get('user'))))
route.post('/alerts/acknowledge',async c=>{const {key}=z.object({key:z.string().min(1).max(100)}).parse(await c.req.json());await db.execute('INSERT INTO platform_alert_acknowledgements(alert_key,user_id) VALUES(?,?) ON DUPLICATE KEY UPDATE acknowledged_at=NOW()',[key,c.get('user').id]);return ok(c,{saved:true})})
route.get('/mfa',async c=>ok(c,await new MfaService().status(c.get('user').id)))
route.post('/mfa/setup',loginRateLimit,async c=>{const {password}=z.object({password:z.string().min(8).max(128)}).parse(await c.req.json());return ok(c,await new MfaService().begin(c.get('user').id,password))})
route.post('/mfa/confirm',async c=>{const {code}=z.object({code:z.string().regex(/^\d{6}$/)}).parse(await c.req.json());return ok(c,await new MfaService().finish(c.get('user').id,c.get('user').companyId,code))})
route.get('/alerts/:kind',async c=>{
 const kind=z.enum(['errors','exports','backup','disk','memory']).parse(c.req.param('kind')),q=z.object({page:z.coerce.number().int().min(1).max(100000).default(1),status:z.enum(['open','resolved','all']).default('open')}).parse(c.req.query())
 const data=await new PlatformAlertService().list(kind,q.page,q.status)
 await new AuditService().log(undefined,{companyId:c.get('user').companyId,userId:c.get('user').id,module:'platform',action:'alert_details_view',recordType:'platform',newValue:{kind,page:q.page,status:q.status}})
 return ok(c,data)
})
route.post('/errors/:id/resolve',async c=>{const id=z.coerce.number().int().positive().parse(c.req.param('id')),{note}=z.object({note:z.string().trim().min(5).max(1000)}).parse(await c.req.json());return ok(c,await new PlatformAlertService().resolve(id,note,c.get('user')))})
export default route
