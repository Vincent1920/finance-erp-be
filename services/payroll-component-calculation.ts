export type ComponentSnapshot = {
 id: number; code: string; name: string; kind: 'earning' | 'deduction';
 channel: 'payroll' | 'noncash' | 'external_cash' | 'external_noncash';
 basis: 'nominal' | 'attendance' | 'overtime'; rate: number; taxable: boolean; bpjs_base: boolean;
 expense_account_id: number | null; contra_account_id: number | null;
 recurring_metadata?: {assignment_id:number;base_amount:number;prorate:boolean;from:string;to:string}; tax_note?: string; policy_reference: string; version: number; effective_from: string; effective_to: string | null;
}
export const payrollRound = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100
export const readComponentSnapshot = (value: unknown): ComponentSnapshot => typeof value === 'string' ? JSON.parse(value) : value as ComponentSnapshot
export function componentTotals(lines: Array<Record<string, any>>) {
 const result = { earnings: 0, payrollCash: 0, cash: 0, noncash: 0, external: 0, taxable: 0, bpjs: 0, deductions: 0 }
 for (const line of lines) {
  const c = readComponentSnapshot(line.snapshot), amount = Number(line.amount), taxable = Number(line.taxable_amount)
  if (c.kind === 'deduction') { result.deductions += amount; result.taxable -= taxable; continue }
  result.earnings += amount
  if (c.channel === 'payroll') result.payrollCash += amount
  if (c.channel === 'payroll' || c.channel === 'external_cash') result.cash += amount
  else result.noncash += amount
  if (c.channel.startsWith('external_')) result.external += amount
  result.taxable += taxable
  if (c.bpjs_base) result.bpjs += amount
 }
 return Object.fromEntries(Object.entries(result).map(([key,value])=>[key,payrollRound(value)])) as typeof result
}
