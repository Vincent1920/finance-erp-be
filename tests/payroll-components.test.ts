import { describe, test, expect } from 'bun:test'
import { componentTotals } from '../services/payroll-component-calculation'
const line=(amount:number,channel:string,taxable=amount,kind='earning',bpjs=false)=>({amount,taxable_amount:taxable,snapshot:JSON.stringify({channel,kind,bpjs_base:bpjs})})
describe('Payroll component accounting separation',()=>{
 test('Noncash and external payments affect benefits/tax without increasing payroll transfer',()=>{
  expect(componentTotals([line(1100000,'payroll'),line(2500000,'noncash',500000),line(600000,'external_noncash',0),line(100000,'payroll',0,'deduction')])).toEqual({earnings:4200000,payrollCash:1100000,cash:1100000,noncash:3100000,external:600000,taxable:1600000,bpjs:0,deductions:100000})
 })
 test('External cash remains cash income but is excluded from bank payroll',()=>{const totals=componentTotals([line(2000000,'external_cash',2000000)]);expect(totals.cash).toBe(2000000);expect(totals.payrollCash).toBe(0);expect(totals.external).toBe(2000000)})
 test('Selected contributions and tax-reducing deductions use independent bases',()=>{const totals=componentTotals([line(500000,'payroll',500000,'earning',true),line(50000,'payroll',50000,'deduction')]);expect(totals.bpjs).toBe(500000);expect(totals.taxable).toBe(450000);expect(totals.deductions).toBe(50000)})
})
