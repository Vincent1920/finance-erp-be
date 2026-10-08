import assert from 'node:assert/strict'
import { db } from '../config/database'
import { PurchaseInvoiceService } from '../services/PurchaseInvoiceService'
import { SalesInvoiceService } from '../services/SalesInvoiceService'
import { purchaseInvoiceSchema } from '../validators/purchase-invoice.validator'
import { salesInvoiceSchema } from '../validators/sales-invoice.validator'

/** Run only inside the disposable operational verification schema. */
export async function inventoryStress(input: { item: number; warehouse: number; supplier: number; customer: number; unit: number; inventoryAccount: number; actor: any; approver: any; fifo?: boolean }) {
  if (!/^finora_verify_\d+_\d+$/.test(process.env.DB_NAME ?? '')) throw new Error('Inventory stress requires the disposable verification database')
  const purchase = new PurchaseInvoiceService(), sales = new SalesInvoiceService()
  let qty = 0, value = 0, average = 0, purchased = 0, cogs = 0
  const round = (n: number, digits = 2) => Number(n.toFixed(digits))
  const halfUp = (n: bigint, d: bigint) => (n + d / 2n) / d
  const layers: Array<{quantity:bigint;value:bigint;price:bigint}> = []
  for (let i = 0; i < 40; i++) {
    const q = round(2 + (i % 7) / 10, 1), price = 100 + i * 17.13
    const pi = await purchase.create(1, purchaseInvoiceSchema.parse({ supplier_invoice_number: `STRESS-${input.fifo?'FIFO-':''}${i}`, invoice_date: '2026-12-03', due_date: '2026-12-31', supplier_id: input.supplier, warehouse_id: input.warehouse, lines: [{ item_id: input.item, unit_id: input.unit, quantity: q, unit_price: price }] }), input.actor)
    if (i === 0) {
      await assert.rejects(() => purchase.post(pi.id, 1, input.actor), 'Disabled bypass rejects draft posting')
      await db.execute("INSERT INTO settings(company_id,setting_key,setting_value,value_type,category,is_secret) VALUES(1,'accounting.bypass_workflow','true','boolean','accounting',0) ON DUPLICATE KEY UPDATE setting_value='true'")
      await purchase.post(pi.id, 1, input.actor)
      await db.execute("UPDATE settings SET setting_value='false' WHERE company_id=1 AND setting_key='accounting.bypass_workflow'")
    } else {
      await purchase.submit(pi.id, 1, input.actor); await purchase.approve(pi.id, 1, input.approver); await purchase.post(pi.id, 1, input.actor)
    }
    const incoming = Number(halfUp(BigInt(Math.round(q * 10)) * BigInt(Math.round(price * 100)), 10n)) / 100; purchased = round(purchased + incoming)
    layers.push({quantity:BigInt(Math.round(q*10)),value:BigInt(Math.round(incoming*100)),price:halfUp(BigInt(Math.round(incoming*100))*100000n,BigInt(Math.round(q*10)))})
    qty = round(qty + q, 4); value = round(value + incoming); average = Number(halfUp(BigInt(Math.round(value * 100)) * 100000n, BigInt(Math.round(qty * 10)))) / 1000000
    const issued = i === 39 ? qty : round(1 + (i % 3) / 10, 1)
    let expense = issued === qty ? value : Number(halfUp(BigInt(Math.round(issued * 10)) * BigInt(Math.round(average * 1000000)), 100000n)) / 100
    if(input.fifo){
      let remaining=BigInt(Math.round(issued*10)),cost=0n
      for(const layer of layers){
        if(!remaining)break
        const take=remaining<layer.quantity?remaining:layer.quantity
        const consumed=take===layer.quantity?layer.value:halfUp(take*layer.price,100000n)
        layer.quantity-=take;layer.value-=consumed;remaining-=take;cost+=consumed
      }
      assert.equal(remaining,0n);expense=Number(cost)/100
    }
    const si = await sales.create(1, salesInvoiceSchema.parse({ invoice_date: '2026-12-03', due_date: '2026-12-31', customer_id: input.customer, warehouse_id: input.warehouse, lines: [{ item_id: input.item, unit_id: input.unit, quantity: issued, unit_price: 1000 }] }), input.actor)
    await sales.submit(si.id, 1, input.actor); await sales.approve(si.id, 1, input.approver); await sales.post(si.id, 1, input.actor)
    qty = round(qty - issued, 4); value = round(value - expense); cogs = round(cogs + expense)
    if (!qty) average = 0
    const [balances] = await db.query<any[]>('SELECT quantity,total_value FROM inventory_balances WHERE company_id=1 AND item_id=? AND warehouse_id=?', [input.item, input.warehouse])
    assert.equal(Number(balances[0].quantity), qty, `Quantity after cycle ${i}`)
    assert.equal(Number(balances[0].total_value), value, `Value after cycle ${i}`)
  }
  const [movements] = await db.query<any[]>('SELECT SUM(quantity_in-quantity_out) qty,SUM(CASE WHEN quantity_in>0 THEN total_cost ELSE -total_cost END) value FROM inventory_movements WHERE company_id=1 AND item_id=?', [input.item])
  assert.equal(Number(movements[0].qty), qty); assert.equal(Number(movements[0].value), value)
  assert.equal(round(purchased - cogs), value)
  const [journal] = await db.query<any[]>("SELECT SUM(l.debit-l.credit) value FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.company_id=1 AND j.status IN ('posted','reversed') AND l.account_id=? AND (j.id IN (SELECT journal_id FROM purchase_invoices WHERE company_id=1 AND supplier_invoice_number LIKE 'STRESS-%') OR j.id IN (SELECT journal_id FROM inventory_movements WHERE company_id=1 AND item_id=?))", [input.inventoryAccount, input.item])
  assert.equal(Number(journal[0].value ?? 0), value, 'Inventory GL equals stock value')
  console.log(`PASS ${input.fifo?'FIFO':'average'} inventory stress: 80 posted invoices, 80 balance checks, final qty=${qty}, value=${value}, purchases=${purchased}, COGS=${cogs}`)
}
