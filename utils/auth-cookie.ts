import {getCookie,setCookie,deleteCookie} from 'hono/cookie'
import {createHmac,timingSafeEqual} from 'node:crypto'
import type {Context} from 'hono'
import jwt from 'jsonwebtoken'
import {env} from '../config/env'
import {ForbiddenError} from './AppError'
export const authCookieName=()=>env.APP_ENV==='production'?'__Secure-finora_session':'finora_session'
export const csrfValue=(token:string)=>createHmac('sha256',env.JWT_SECRET).update('finora-csrf:'+token).digest('hex')
export function setAuthCookies(c:Context,token:string,remember=true){const claims=jwt.decode(token) as {exp:number};const maxAge=Math.max(0,claims.exp-Math.floor(Date.now()/1000));const opts={secure:env.APP_ENV==='production',sameSite:'Strict' as const};setCookie(c,authCookieName(),token,{...opts,httpOnly:true,path:'/api',...(remember?{maxAge}:{})});setCookie(c,'finora_csrf',csrfValue(token),{...opts,path:'/',...(remember?{maxAge}:{})});c.header('Cache-Control','no-store')}
export function clearAuthCookies(c:Context){deleteCookie(c,authCookieName(),{path:'/api',secure:env.APP_ENV==='production'});deleteCookie(c,'finora_csrf',{path:'/',secure:env.APP_ENV==='production'})}
export function browserOrigin(c:Context){const origin=c.req.header('Origin');if(!origin)return;const configured=new URL(env.FRONTEND_URL).origin,allowed=env.APP_ENV==='development'?[configured,configured.replace('localhost','127.0.0.1'),configured.replace('127.0.0.1','localhost')]:[configured];if(!allowed.includes(origin))throw new ForbiddenError('Origin permintaan tidak diizinkan')}
export function csrfCheck(c:Context,token:string){if(['GET','HEAD','OPTIONS'].includes(c.req.method))return;browserOrigin(c);const supplied=c.req.header('X-CSRF-Token')??'',expected=csrfValue(token);if(supplied.length!==expected.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))throw new ForbiddenError('Token CSRF tidak sesuai. Muat ulang halaman dan coba kembali.')}
export const cookieToken=(c:Context)=>getCookie(c,authCookieName())
