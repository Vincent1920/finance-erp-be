import {Hono} from 'hono'
import {z} from 'zod'
import {db} from '../config/database'
import {ok} from '../utils/response'
import type {AppBindings} from '../types/hono'
const route=new Hono<AppBindings>()
const keySchema=z.string().regex(/^[a-z0-9:_-]{1,100}$/)
route.get('/:key',async c=>{const key=keySchema.parse(c.req.param('key')),user=c.get('user');const [rows]=await db.execute<any[]>('SELECT value_json FROM user_preferences WHERE company_id=? AND user_id=? AND preference_key=?',[user.companyId,user.id,key]);return ok(c,rows[0]?.value_json??null)})
route.put('/:key',async c=>{const key=keySchema.parse(c.req.param('key')),user=c.get('user'),value=(key==='interface-language'?z.tuple([z.enum(['id-ID','en-US','zh-CN'])]):z.array(z.string().max(100)).max(50)).parse(await c.req.json());await db.execute('INSERT INTO user_preferences(company_id,user_id,preference_key,value_json) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE value_json=VALUES(value_json)',[user.companyId,user.id,key,JSON.stringify(value)]);return ok(c,value)})
export default route
