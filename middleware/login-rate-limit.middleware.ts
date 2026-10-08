import {createMiddleware} from 'hono/factory'
import {getConnInfo} from 'hono/bun'
import {createHash} from 'node:crypto'
import {transaction} from '../config/database'
import {AppError} from '../utils/AppError'
export function clientAddress(c:any){
 try{const peer=getConnInfo(c).remote.address;const trusted=(process.env.TRUSTED_PROXY_IPS??'').split(',').map(x=>x.trim());if(peer&&trusted.includes(peer)){const forwarded=c.req.header('x-real-ip');return forwarded??peer}return peer??'unknown'}catch{return 'unknown'}
}
export const loginRateLimit=createMiddleware(async(c,next)=>{
 const bucket=createHash('sha256').update('login-ip:'+clientAddress(c)).digest('hex')
 const blocked=await transaction(async cx=>{
  await cx.execute("INSERT IGNORE INTO auth_login_limits(bucket,attempts,reset_at) VALUES(?,0,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 15 MINUTE))",[bucket])
  const [rows]=await cx.query<any[]>('SELECT attempts,reset_at,(reset_at<=UTC_TIMESTAMP(3)) expired FROM auth_login_limits WHERE bucket=? FOR UPDATE',[bucket])
  const expired=Boolean(rows[0].expired),count=expired?0:Number(rows[0].attempts)
  if(count>=30)return true
  await cx.execute('UPDATE auth_login_limits SET attempts=?,reset_at=IF(?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 15 MINUTE),reset_at) WHERE bucket=?',[count+1,expired,bucket]);return false
 })
 if(blocked){c.header('Retry-After','900');throw new AppError('Terlalu banyak percobaan login dari koneksi ini. Coba lagi setelah 15 menit.',429)}
 await next()
})
