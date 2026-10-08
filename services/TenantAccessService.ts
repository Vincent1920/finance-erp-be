import type {QueryExecutor} from '../types/database'
import {db} from '../config/database'
import {ForbiddenError,ConflictError} from '../utils/AppError'
export async function assertTenantAccess(companyId:number){
 const [r]=await db.query<any[]>(`SELECT c.status,c.valid_until, c.valid_until<UTC_DATE() expired FROM platform_companies p JOIN platform_customers c ON c.id=p.customer_id WHERE p.company_id=?`,[companyId])
 if(r[0]&&(r[0].status==='suspended'||r[0].expired))throw new ForbiddenError('Layanan perusahaan ditangguhkan atau masa langganan berakhir. Hubungi pengelola perusahaan.')
}
export async function assertUserQuota(cx:QueryExecutor,companyId:number){
 const [r]=await cx.execute<any[]>(`SELECT c.id,p.max_users FROM platform_companies x JOIN platform_customers c ON c.id=x.customer_id JOIN platform_plans p ON p.code=c.plan_code WHERE x.company_id=? FOR UPDATE`,[companyId]);if(!r[0])return
 const [count]=await cx.execute<any[]>(`SELECT COUNT(*) n FROM users u JOIN platform_companies c ON c.company_id=u.company_id WHERE c.customer_id=? AND u.status='active' AND u.deleted_at IS NULL FOR UPDATE`,[r[0].id]);if(Number(count[0].n)>=Number(r[0].max_users))throw new ConflictError('Kuota pengguna aktif paket telah tercapai')
}
