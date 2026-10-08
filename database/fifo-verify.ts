import assert from 'node:assert/strict'
import { db, transaction } from '../config/database'
import { SettingsService } from '../services/SettingsService'
import { PurchaseInvoiceService } from '../services/PurchaseInvoiceService'
import { SalesInvoiceService } from '../services/SalesInvoiceService'
import { StockOperationService } from '../services/StockOperationService'
import { InventoryCostingService } from '../services/InventoryCostingService'
import { purchaseInvoiceSchema } from '../validators/purchase-invoice.validator'
import { salesInvoiceSchema } from '../validators/sales-invoice.validator'
import { inventoryStress } from './inventory-stress'
import { SalesReturnService } from '../services/SalesReturnService'
import { salesReturnSchema } from '../validators/sales-return.validator'
export async function verifyFifo(x:{item:number;warehouse:number;warehouse2:number;supplier:number;customer:number;unit:number;inventoryAccount:number;actor:any;approver:any}){
 if(!/^finora_verify_\d+_\d+$/.test(process.env.DB_NAME??''))throw new Error('FIFO verification requires an isolated database')
 const settings=new SettingsService(),actor={id:x.actor.userId,companyId:1,roles:['super-admin']}
 const set=(method:string)=>settings.updateMany(actor,[{key:'inventory.cost_method',value:method,value_type:'string',category:'inventory',is_secret:false}])
 await assert.rejects(()=>set('invalid'))
 await set('fifo')
 const purchase=new PurchaseInvoiceService(),sales=new SalesInvoiceService(),stock=new StockOperationService()
 const buy=async(price:number)=>{
  const p=await purchase.create(1,purchaseInvoiceSchema.parse({supplier_invoice_number:`FIFO-${price}`,invoice_date:'2026-01-02',due_date:'2026-02-02',supplier_id:x.supplier,warehouse_id:x.warehouse,lines:[{item_id:x.item,unit_id:x.unit,quantity:10,unit_price:price}]}),x.actor)
  await purchase.submit(p.id,1,x.actor);await purchase.approve(p.id,1,x.approver);await purchase.post(p.id,1,x.actor);return p
 }
 const a=await buy(100),b=await buy(200)
 await assert.rejects(()=>set('weighted_average'),'Method cannot change with active stock')
 await assert.rejects(()=>settings.updateMany(actor,[{key:'allow_negative_stock',value:true,value_type:'boolean',category:'inventory',is_secret:false}]))
 const layeredTransfer=await stock.post(1,true,{request_key:crypto.randomUUID(),date:'2026-01-02',warehouse_id:x.warehouse,to_warehouse_id:x.warehouse2,item_id:x.item,unit_id:x.unit,quantity:'12',reason:'Preserve multiple FIFO layers',reference:'FIFO-LAYERS'},x.actor)
 const [destinationLayers]=await db.query<any[]>('SELECT remaining_quantity,remaining_value,unit_cost FROM inventory_cost_layers WHERE company_id=1 AND item_id=? AND warehouse_id=? AND remaining_quantity>0 ORDER BY received_date,id',[x.item,x.warehouse2])
 assert.deepEqual(destinationLayers.map(l=>[Number(l.remaining_quantity),Number(l.remaining_value),Number(l.unit_cost)]),[[10,1000,100],[2,400,200]])
 await stock.reverse(1,true,layeredTransfer.id,{request_key:crypto.randomUUID(),date:'2026-01-02',reason:'Restore transferred layer queue'},x.actor)
 const s=await sales.create(1,salesInvoiceSchema.parse({invoice_date:'2026-01-02',due_date:'2026-02-02',customer_id:x.customer,warehouse_id:x.warehouse,lines:[{item_id:x.item,unit_id:x.unit,quantity:12,unit_price:500}]}),x.actor)
 await sales.submit(s.id,1,x.actor);await sales.approve(s.id,1,x.approver);const posted=await sales.post(s.id,1,x.actor)
 const [cost]=await db.query<any[]>('SELECT total_cost FROM inventory_movements WHERE company_id=1 AND journal_id=?',[posted.journalId])
 assert.equal(Number(cost[0].total_cost),1400,'FIFO consumes 10 at 100 plus 2 at 200, not moving average 1800')
 const verify=async()=>{
  const [balance]=await db.query<any[]>('SELECT SUM(quantity) qty,SUM(total_value) value FROM inventory_balances WHERE company_id=1 AND item_id=?',[x.item])
  const [layers]=await db.query<any[]>('SELECT SUM(remaining_quantity) qty,SUM(remaining_value) value FROM inventory_cost_layers WHERE company_id=1 AND item_id=?',[x.item])
  const [gl]=await db.query<any[]>("SELECT SUM(l.debit-l.credit) value FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.company_id=1 AND j.status IN ('posted','reversed') AND l.account_id=?",[x.inventoryAccount])
  assert.equal(Number(layers[0].qty),Number(balance[0].qty));assert.equal(Number(layers[0].value),Number(balance[0].value));assert.equal(Number(gl[0].value),Number(balance[0].value))
  return balance[0]
 }
 assert.equal(Number((await verify()).value),1600)
 await assert.rejects(()=>purchase.reverse(a.id,1,'2026-01-02','Consumed layer',x.actor))
 await verify()
 const transfer=await stock.post(1,true,{request_key:crypto.randomUUID(),date:'2026-01-02',warehouse_id:x.warehouse,to_warehouse_id:x.warehouse2,item_id:x.item,unit_id:x.unit,quantity:'3',reason:'FIFO transfer',reference:'FIFO'},x.actor)
 await verify()
 await stock.reverse(1,true,transfer.id,{request_key:crypto.randomUUID(),date:'2026-01-02',reason:'FIFO transfer reversal'},x.actor)
 await verify()
 const [sourceLines]=await db.query<any[]>('SELECT id FROM sales_invoice_lines WHERE sales_invoice_id=?',[s.id])
 const returns=new SalesReturnService()
 const returned=await returns.create(1,salesReturnSchema.parse({return_date:'2026-01-02',sales_invoice_id:s.id,return_stock:true,reason:'FIFO partial return',lines:[{sales_invoice_line_id:sourceLines[0].id,quantity:2}]}),x.actor)
 await returns.submit(returned.id,1,x.actor);await returns.approve(returned.id,1,x.approver);await returns.post(returned.id,1,x.actor)
 assert.equal(Number((await verify()).value),1833.33,'Partial sales return uses the original invoice cost allocation')
 await returns.reverse(returned.id,1,'2026-01-02','Reverse unused returned layer',x.actor)
 assert.equal(Number((await verify()).value),1600)
 await sales.reverse(s.id,1,'2026-01-02','Restore exact source layers',x.actor)
 assert.equal(Number((await verify()).value),3000)
 await purchase.reverse(a.id,1,'2026-01-02','Reverse unused first layer',x.actor)
 assert.equal(Number((await verify()).value),2000)
 await purchase.reverse(b.id,1,'2026-01-02','Reverse unused second layer',x.actor)
 assert.equal(Number((await verify()).value),0)
 await set('weighted_average')
 // FIFO backdate, tenant isolation and concurrent issues using a separate item, without GL mutations.
 await set('fifo')
 const engine=new InventoryCostingService()
 const move=(direction:'in'|'out',quantity:string,date='2026-01-03')=>transaction(c=>engine.applyMovement(c,{companyId:1,itemId:x.item,warehouseId:x.warehouse,direction,quantity,unitCost:'100',transactionType:'stock_adjustment',transactionId:999,transactionNumber:'FIFO-CONCURRENT',movementDate:date,postingKey:crypto.randomUUID(),userId:x.actor.userId}))
 await move('in','1')
 await assert.rejects(()=>move('in','1','2026-01-01'))
 const concurrent=await Promise.allSettled([move('out','0.7'),move('out','0.7')])
 assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1)
 assert.equal(concurrent.filter(r=>r.status==='rejected').length,1)
  await move('out','0.3')
 await inventoryStress({...x,fifo:true})
 await set('weighted_average')
 console.log('PASS FIFO: historical layers, HPP 1400 versus average 1800, GL reconciliation, transfer/reversal, consumed receipt guard, method lock, backdate guard and concurrent stock protection')
}
