import {test,expect} from 'bun:test'
import {db} from '../config/database'
import type {ResultSetHeader} from 'mysql2/promise'
import {InventoryRepository} from '../repositories/InventoryRepository'
import {InventoryService} from '../services/InventoryService'
import {ReportExportService} from '../services/ReportExportService'
import {app} from '../app'
import {signToken} from '../utils/token'
import {ReportRepository} from '../repositories/ReportRepository'
const integration=process.env.RUN_FOUNDATION_DB_TESTS==='1'?test:test.skip
integration('decimal stock opening, immutable exports and tenant/user preferences',async()=>{
  const insert=async(sql:string,values:any[])=> (await db.execute<ResultSetHeader>(sql,values))[0].insertId
  const cid=await insert('INSERT INTO companies(name,base_currency) VALUES(?,?)',['Report verification','USD'])
  const otherCid=await insert('INSERT INTO companies(name,base_currency) VALUES(?,?)',['Other verification','IDR'])
  const uid=await insert('INSERT INTO users(company_id,name,email,password) VALUES(?,?,?,?)',[cid,'maker',`${crypto.randomUUID()}@example.invalid`,'no-login'])
  const otherUid=await insert('INSERT INTO users(company_id,name,email,password) VALUES(?,?,?,?)',[cid,'other',`${crypto.randomUUID()}@example.invalid`,'no-login'])
  const otherCompanyUid=await insert('INSERT INTO users(company_id,name,email,password) VALUES(?,?,?,?)',[otherCid,'other tenant',`${crypto.randomUUID()}@example.invalid`,'no-login'])
  const unit=await insert('INSERT INTO units(company_id,code,name,symbol) VALUES(?,?,?,?)',[cid,'PCS','Pieces','pcs'])
  const warehouse=await insert('INSERT INTO warehouses(company_id,code,name) VALUES(?,?,?)',[cid,'WH','Warehouse'])
  const item=await insert('INSERT INTO items(company_id,sku,name,item_type,unit_id) VALUES(?,?,?,?,?)',[cid,'TEST','Decimal item','inventory',unit])
  const repo=new InventoryRepository()
  let n=0
  const movement=async(date:string,incoming:string,outgoing:string,cost:string)=>repo.insertMovement(db,{companyId:cid,itemId:item,warehouseId:warehouse,transactionType:'stock_adjustment',transactionId:1,transactionNumber:`TEST-${++n}`,movementDate:date,quantityIn:incoming,quantityOut:outgoing,unitCost:'1',totalCost:cost,runningQuantity:'0',runningValue:'0',postingKey:crypto.randomUUID(),userId:uid})
  await movement('2026-09-30','0.1','0','0.1')
  await movement('2026-10-01','0.2','0','0.2')
  await movement('2026-10-02','0','0.1','0.1')
  const filters={date_from:'2026-10-01',date_to:'2026-10-31'}
  const summary=await new InventoryService().summary(cid,filters)
  expect(Number(summary[0]!.opening_quantity)).toBe(0.1)
  expect(Number(summary[0]!.chronological_quantity)).toBe(0.2)
  expect(Number(summary[0]!.chronological_value)).toBe(0.2)
  expect(summary[0]!.report_currency).toBe('USD')
  expect((await new InventoryService().summary(otherCid,filters)).length).toBe(0)
  const user={id:uid,companyId:cid,name:'maker',email:'test@example.invalid',roles:[],permissions:['inventory.view','reports.view']}
  const service=new ReportExportService()
  const job=await service.create(user,{report:'stock_summary',format:'csv',filters})
  await service.processNext()
  const first=await service.get(user,job.id,true)
  expect(first.status).toBe('ready');expect(first.row_count).toBe(1)
  expect(Buffer.from(first.output).toString()).toContain('USD')
  await movement('2026-10-03','10','0','10')
  expect(Buffer.from((await service.get(user,job.id,true)).output).equals(Buffer.from(first.output))).toBe(true)
  await expect(service.get({...user,id:otherUid},job.id)).rejects.toThrow()
  await expect(service.get({...user,companyId:otherCid},job.id)).rejects.toThrow()
  await db.execute('UPDATE report_exports SET expires_at=DATE_SUB(NOW(),INTERVAL 1 SECOND) WHERE id=?',[job.id])
  await expect(service.get(user,job.id)).rejects.toThrow()
  const request=async(id:number,companyId:number,method='GET',body?:unknown)=>{const token=signToken({id,companyId});const [valid]=await db.query<any[]>("SELECT id FROM users WHERE id=? AND company_id=? AND status='active'",[id,companyId]);if(valid.length)await new (await import('../services/AuthSessionService')).AuthSessionService().register(token,id,companyId);return app.request('/api/preferences/stock-summary-columns',{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined})}
  expect((await request(uid,cid,'PUT',['warehouse_name'])).status).toBe(200)
  expect((await (await request(uid,cid)).json()).data).toEqual(['warehouse_name'])
  expect((await (await request(otherUid,cid)).json()).data).toBeNull()
  expect((await (await request(otherCompanyUid,otherCid)).json()).data).toBeNull()
  expect((await request(uid,otherCid)).status).toBe(401)
  const pdfJob=await service.create(user,{report:'stock_card',format:'pdf',filters})
  await service.processNext()
  expect(Buffer.from((await service.get(user,pdfJob.id,true)).output).subarray(0,5).toString()).toBe('%PDF-')
  for(const report of ['profit_loss','balance_sheet','cash_flow','trial_balance']){
    const financialJob=await service.create(user,{report,format:'pdf',filters})
    await service.processNext()
    expect(Buffer.from((await service.get(user,financialJob.id,true)).output).subarray(0,5).toString()).toBe('%PDF-')
  }
  const customer=await insert('INSERT INTO customers(company_id,code,name) VALUES(?,?,?)',[cid,'C1','EUR customer'])
  await db.execute(`INSERT INTO sales_invoices(company_id,invoice_number,invoice_date,due_date,customer_id,subtotal,grand_total,outstanding_amount,status,created_by,currency,exchange_rate,base_grand_total) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,[cid,'EUR-TEST','2026-10-01','2026-10-15',customer,'10','10','10','posted',uid,'EUR','1.2','12'])
  const aging=await new ReportRepository().aging(cid,'receivable','2026-10-31')
  expect(aging.length).toBe(1);expect(aging[0]!.currency).toBe('USD');expect(aging[0]!.transaction_currency).toBe('EUR');expect(Number(aging[0]!.original_amount)).toBe(12)
  await db.end()
},30000)
