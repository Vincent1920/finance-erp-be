import { test, expect } from 'bun:test'
import { payrollProration, proratedMoney } from '../services/payroll-proration'
test('Calendar proration includes joining and leaving dates, leap years and preserves full-month wages',()=>{
 const jan=payrollProration('2026-01-01','2026-01-31','2026-01-16',null,'calendar');expect(jan.eligibleDays).toBe(16);expect(jan.periodDays).toBe(31);expect(proratedMoney(3100000,jan.ratio)).toBe(1600000)
 expect(payrollProration('2024-02-01','2024-02-29','2024-02-01','2024-02-29','calendar').ratio).toBe(1)
 expect(payrollProration('2026-01-01','2026-01-31','2026-01-16',null,'none').ratio).toBe(1)
})
test('Working-day proration follows selected weekday schedule and never counts weekends twice',()=>{const work=payrollProration('2026-01-01','2026-01-31','2026-01-16','2026-01-30','working_days');expect(work.periodDays).toBe(22);expect(work.eligibleDays).toBe(11);expect(proratedMoney(6000000,work.ratio)).toBe(3000000)})
