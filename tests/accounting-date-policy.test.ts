import { test,expect } from 'bun:test'
import { assertAccountingDate } from '../services/AccountingDatePolicy'
test('accounting cutoff locks its boundary and earlier dates',()=>{
  const policy={'accounting.transaction_lock_date':'2026-09-30'}
  expect(()=>assertAccountingDate('2026-09-30','2026-10-04',policy)).toThrow('dikunci')
  expect(()=>assertAccountingDate('2026-10-01','2026-10-04',policy)).not.toThrow()
})
test('backdate allowance and future date control are independent',()=>{
  const policy={'accounting.max_backdate_days':3,'accounting.allow_future_dates':false}
  expect(()=>assertAccountingDate('2026-10-01','2026-10-04',policy)).not.toThrow()
  expect(()=>assertAccountingDate('2026-09-30','2026-10-04',policy)).toThrow('3 hari')
  expect(()=>assertAccountingDate('2026-10-05','2026-10-04',policy)).toThrow('masa depan')
  expect(()=>assertAccountingDate('2026-01-01','2026-10-04',{})).not.toThrow()
})
