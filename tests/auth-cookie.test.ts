import {expect,test} from 'bun:test'
import {Hono} from 'hono'
import {env} from '../config/env'
import {setAuthCookies,csrfCheck,csrfValue} from '../utils/auth-cookie'
import {signToken} from '../utils/token'
import {AppError} from '../utils/AppError'
test('production auth cookie is Secure HttpOnly and session scoped CSRF rejects missing or cross-origin headers',async()=>{
 const before=env.APP_ENV;env.APP_ENV='production'
 try{
  const token=signToken({id:1,companyId:1}),api=new Hono()
  api.onError(e=>new Response('',{status:e instanceof AppError?e.status:500}))
  api.get('/issue',c=>{setAuthCookies(c,token,false);return c.json({ok:true})})
  api.post('/check',c=>{csrfCheck(c,token);return c.json({ok:true})})
  const response=await api.request('https://staging.verify/issue'),cookies=response.headers.getSetCookie()
  const session=cookies.find(s=>s.startsWith('__Secure-finora_session='))!
  expect(session).toContain('Secure');expect(session).toContain('HttpOnly');expect(session).toContain('SameSite=Strict');expect(session).not.toContain('Max-Age')
  expect((await api.request('/check',{method:'POST'})).status).toBe(403)
  expect((await api.request('/check',{method:'POST',headers:{'X-CSRF-Token':csrfValue(token),Origin:'https://untrusted.invalid'}})).status).toBe(403)
  expect((await api.request('/check',{method:'POST',headers:{'X-CSRF-Token':csrfValue(token),Origin:env.FRONTEND_URL}})).status).toBe(200)
 }finally{env.APP_ENV=before}
})
