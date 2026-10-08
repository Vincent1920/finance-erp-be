import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import type { QueryExecutor } from '../types/database'
import { InventoryRepository, type InventoryBalanceRow } from '../repositories/InventoryRepository'
import type { InventoryMovementInput } from './InventoryCostingService'
import { addDecimal, subtractDecimal, multiplyDecimal, divideDecimal, compareDecimal, normalizeDecimal } from '../utils/decimal'
import { ConflictError } from '../utils/AppError'
export type CostSlice = { layerId?: number; quantity:string; value:string; unitCost:string; date:string }
const dateOnly=(v:unknown)=>v instanceof Date?v.toISOString().slice(0,10):String(v).slice(0,10)
export class FifoCostingService {
 async apply(connection:QueryExecutor,input:InventoryMovementInput,balance:InventoryBalanceRow){
  const repo=new InventoryRepository(),q=normalizeDecimal(input.quantity,4)
  const [latest]=await connection.execute<RowDataPacket[]>('SELECT movement_date date FROM inventory_movements WHERE company_id=? AND item_id=? AND warehouse_id=? ORDER BY movement_date DESC,id DESC LIMIT 1 FOR UPDATE',[input.companyId,input.itemId,input.warehouseId])
  if(latest[0]?.date&&input.movementDate<dateOnly(latest[0].date))throw new ConflictError('FIFO: tanggal mutasi tidak boleh mendahului mutasi terakhir barang/gudang')
  const [layerBalances]=await connection.execute<RowDataPacket[]>('SELECT COALESCE(SUM(remaining_quantity),0) quantity,COALESCE(SUM(remaining_value),0) value FROM inventory_cost_layers WHERE company_id=? AND item_id=? AND warehouse_id=? FOR UPDATE',[input.companyId,input.itemId,input.warehouseId])
  if(compareDecimal(String(layerBalances[0]!.quantity),String(balance.quantity),4)!==0||compareDecimal(String(layerBalances[0]!.value),String(balance.total_value))!==0)throw new ConflictError('Saldo layer FIFO tidak sesuai register stok; lakukan rekonsiliasi sebelum posting')
  const slices:CostSlice[]=[]
  let cost='0.00'
  if(input.direction==='out'){
   if(compareDecimal(q,String(balance.quantity),4)>0)throw new ConflictError('FIFO tidak mengizinkan stok negatif')
   const [layers]=await connection.execute<RowDataPacket[]>(`SELECT * FROM inventory_cost_layers WHERE company_id=? AND item_id=? AND warehouse_id=? AND remaining_quantity>0 ${input.isReversal?'AND receipt_movement_id=?':''} ORDER BY received_date,id FOR UPDATE`,[input.companyId,input.itemId,input.warehouseId,...(input.isReversal?[Number(input.reversalMovementId)]:[])])
   if(input.isReversal&&compareDecimal(addDecimal(layers.map(l=>String(l.remaining_quantity)),4),q,4)!==0)throw new ConflictError('Layer penerimaan FIFO telah digunakan; balik transaksi pemakai terlebih dahulu')
   let remaining=q
   for(const layer of layers){
    if(compareDecimal(remaining,'0',4)===0)break
    const take=compareDecimal(remaining,String(layer.remaining_quantity),4)<0?remaining:String(layer.remaining_quantity)
    let value=compareDecimal(take,String(layer.remaining_quantity),4)===0?normalizeDecimal(String(layer.remaining_value)):multiplyDecimal(take,4,String(layer.unit_cost),6,2)
    if(compareDecimal(value,String(layer.remaining_value))>0)value=normalizeDecimal(String(layer.remaining_value))
    slices.push({layerId:Number(layer.id),quantity:take,value,unitCost:String(layer.unit_cost),date:dateOnly(layer.received_date)})
    await connection.execute('UPDATE inventory_cost_layers SET remaining_quantity=?,remaining_value=? WHERE id=? AND company_id=?',[subtractDecimal(String(layer.remaining_quantity),take,4),subtractDecimal(String(layer.remaining_value),value),layer.id,input.companyId])
    remaining=subtractDecimal(remaining,take,4)
   }
   if(compareDecimal(remaining,'0',4)>0)throw new ConflictError('Layer FIFO tidak cukup untuk mutasi keluar')
   cost=addDecimal(slices.map(s=>s.value))
  }else if(input.isReversal){
   const [allocations]=await connection.execute<RowDataPacket[]>('SELECT a.*,l.received_date,l.unit_cost FROM inventory_cost_allocations a JOIN inventory_cost_layers l ON l.id=a.layer_id AND l.company_id=a.company_id WHERE a.company_id=? AND a.movement_id=? FOR UPDATE',[input.companyId,Number(input.reversalMovementId)])
   if(compareDecimal(addDecimal(allocations.map(a=>String(a.quantity)),4),q,4)!==0)throw new ConflictError('Rincian biaya FIFO asal tidak lengkap; reversal dibatalkan')
   for(const a of allocations){
    await connection.execute('UPDATE inventory_cost_layers SET remaining_quantity=remaining_quantity+?,remaining_value=remaining_value+? WHERE id=? AND company_id=?',[a.quantity,a.total_cost,a.layer_id,input.companyId])
    slices.push({layerId:Number(a.layer_id),quantity:String(a.quantity),value:String(a.total_cost),unitCost:String(a.unit_cost),date:dateOnly(a.received_date)})
   }
   cost=addDecimal(slices.map(s=>s.value))
  }else{
   slices.push(...(input.costSlices??[{quantity:q,value:input.totalCostOverride??multiplyDecimal(q,4,input.unitCost??'0',6,2),unitCost:normalizeDecimal(input.unitCost??'0',6),date:input.movementDate}]))
   if(compareDecimal(addDecimal(slices.map(s=>s.quantity),4),q,4)!==0)throw new ConflictError('Kuantitas layer masuk tidak sesuai mutasi')
   if(slices.some(s=>compareDecimal(s.quantity,'0',4)<=0||compareDecimal(s.value,'0')<0||compareDecimal(s.unitCost,'0',6)<0))throw new ConflictError('Kuantitas dan biaya layer FIFO tidak valid')
   cost=addDecimal(slices.map(s=>s.value))
  }
  const quantity=input.direction==='in'?addDecimal([String(balance.quantity),q],4):subtractDecimal(String(balance.quantity),q,4)
  const value=input.direction==='in'?addDecimal([String(balance.total_value),cost]):subtractDecimal(String(balance.total_value),cost)
  const average=compareDecimal(quantity,'0',4)===0?'0.000000':divideDecimal(value,2,quantity,4,6)
  const unitCost=divideDecimal(cost,2,q,4,6)
  if(compareDecimal(value,'0')<0||compareDecimal(cost,'0')<0)throw new ConflictError('Nilai FIFO tidak boleh negatif')
  await repo.updateBalance(connection,Number(balance.id),quantity,average,value)
  const movementId=await repo.insertMovement(connection,{...input,quantityIn:input.direction==='in'?q:'0',quantityOut:input.direction==='out'?q:'0',unitCost,totalCost:cost,runningQuantity:quantity,runningValue:value})
  await connection.execute("UPDATE inventory_movements SET cost_method='fifo' WHERE id=? AND company_id=?",[movementId,input.companyId])
  for(const s of slices){
   if(input.direction==='in'&&!input.isReversal){
    await connection.execute<ResultSetHeader>('INSERT INTO inventory_cost_layers(company_id,item_id,warehouse_id,receipt_movement_id,received_date,quantity,remaining_quantity,unit_cost,original_value,remaining_value) VALUES(?,?,?,?,?,?,?,?,?,?)',[input.companyId,input.itemId,input.warehouseId,movementId,s.date,s.quantity,s.quantity,s.unitCost,s.value,s.value])
   }else if(input.direction==='out'){
    await connection.execute('INSERT INTO inventory_cost_allocations(company_id,movement_id,layer_id,quantity,total_cost) VALUES(?,?,?,?,?)',[input.companyId,movementId,Number(s.layerId),s.quantity,s.value])
   }
  }
  await repo.refreshItemAverageCost(connection,input.companyId,input.itemId)
  return {movementId,unitCost,totalCost:cost,quantity,value,costSlices:slices}
 }
}
