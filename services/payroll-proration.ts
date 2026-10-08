import { payrollRound } from './payroll-component-calculation'
export const payrollDay=(value:any):string=>typeof value==='string'?value.slice(0,10):new Date(value).toISOString().slice(0,10)
export function payrollProration(from:string,to:string,employmentFrom:string,employmentTo:string|null,method:string,weekdays='1,2,3,4,5'){
 const allowed=new Set(weekdays.split(',').map(Number));let periodDays=0,eligibleDays=0
 for(let time=Date.parse(from+'T00:00:00Z');time<=Date.parse(to+'T00:00:00Z');time+=86400000){const date=new Date(time),day=date.toISOString().slice(0,10);if(method==='working_days'&&!allowed.has(date.getUTCDay()))continue;periodDays++;if(day>=employmentFrom&&(!employmentTo||day<=employmentTo))eligibleDays++}
 const ratio=method==='none'?1:periodDays?eligibleDays/periodDays:0
 return {ratio,periodDays,eligibleDays}
}
export const proratedMoney=(amount:unknown,ratio:number)=>payrollRound(Number(amount??0)*ratio)
