import { test, expect } from 'bun:test'
import { depreciationTarget } from '../services/FixedAssetService'
import { compareDecimal } from '../utils/decimal'

test('declining balance switches to straight line and stops at residual value',()=>{
  expect(depreciationTarget('12000','0',12,1,'declining_balance')).toBe('2000.00')
  expect(depreciationTarget('12000','0',12,12,'declining_balance')).toBe('12000.00')
  expect(depreciationTarget('12000','2000',12,30,'declining_balance')).toBe('10000.00')
  let prior='0.00'
  for(let i=1;i<=12;i++){
    const next=depreciationTarget('12345.67','1000.13',12,i,'declining_balance')
    expect(compareDecimal(next,prior)).toBeGreaterThanOrEqual(0)
    expect(compareDecimal(next,'11345.54')).toBeLessThanOrEqual(0)
    prior=next
  }
  expect(prior).toBe('11345.54')
})
test('existing straight-line calculation and one-month asset stay exact',()=>{
  expect(depreciationTarget('12000','0',12,1)).toBe('1000.00')
  expect(depreciationTarget('12000','2000',1,1,'declining_balance')).toBe('10000.00')
})
