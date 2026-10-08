import type { RowDataPacket } from 'mysql2/promise'
import type { QueryExecutor } from '../types/database'
import { ConflictError } from '../utils/AppError'
import { compareDecimal } from '../utils/decimal'

export async function accountingPolicy(c:QueryExecutor, companyId:number) {
  await c.execute('SELECT id FROM companies WHERE id=? LOCK IN SHARE MODE',[companyId])
  const [rows]=await c.execute<RowDataPacket[]>('SELECT setting_key,setting_value FROM settings WHERE company_id=? AND setting_key LIKE ? LOCK IN SHARE MODE',[companyId,'accounting.%'])
  return Object.fromEntries(rows.map(r=>[String(r.setting_key),String(r.setting_value??'')]))
}
export async function validateFxPolicy(c:QueryExecutor,companyId:number,currency:string,date:string,rate:string|number){
  const p=await accountingPolicy(c,companyId)
  const [companies]=await c.execute<RowDataPacket[]>('SELECT base_currency FROM companies WHERE id=?',[companyId])
  const base=String(companies[0]!.base_currency)
  if(currency===base){if(compareDecimal(rate,1,8)!==0)throw new ConflictError('Kurs mata uang pembukuan harus 1');return}
  if(p['accounting.fx_rate_policy']!=='registered')return
  const [rates]=await c.execute<RowDataPacket[]>('SELECT rate_date,exchange_rate,source FROM exchange_rates WHERE company_id=? AND from_currency=? AND to_currency=? AND rate_date<=? ORDER BY rate_date DESC LIMIT 1',[companyId,currency,base,date])
  const r=rates[0]
  if(!r)throw new ConflictError('Kurs terdaftar belum tersedia untuk tanggal transaksi')
  const d=r.rate_date instanceof Date?r.rate_date.toISOString().slice(0,10):String(r.rate_date).slice(0,10)
  const age=(Date.parse(date)-Date.parse(d))/86400000
  if(age>Number(p['accounting.fx_max_rate_age_days']??7))throw new ConflictError('Kurs terdaftar sudah melewati batas usia; tambahkan kurs terbaru')
  if(p['accounting.fx_rate_source'] && String(r.source)!==p['accounting.fx_rate_source'])throw new ConflictError('Sumber kurs tidak sesuai kebijakan perusahaan')
  if(compareDecimal(rate,String(r.exchange_rate),8)!==0)throw new ConflictError('Kurs transaksi harus sesuai kurs terdaftar perusahaan')
}
