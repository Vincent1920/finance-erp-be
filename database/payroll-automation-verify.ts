import assert from 'node:assert/strict'
import { db } from '../config/database'
import { PayrollService } from '../services/PayrollService'
import { PayrollComponentService } from '../services/PayrollComponentService'
import { PayrollAutomationService } from '../services/PayrollAutomationService'
export async function verifyPayrollAutomation(userId:number,approverId:number,ids:Record<string,number>){
 assert.match(String(process.env.DB_NAME),/^finora_verify_\d+_\d+$/)
 const actor={userId}, payroll=new PayrollService(), master=new PayrollComponentService(), automation=new PayrollAutomationService()
 await db.execute(`INSERT INTO payroll_policies(company_id,effective_from,created_by,salary_expense_account_id,employer_bpjs_expense_account_id,payroll_payable_account_id,bpjs_payable_account_id,pph21_payable_account_id,employee_loan_account_id,other_deduction_account_id) VALUES(1,'2025-02-01',?,?,?,?,?,?,?,?)`,[userId,ids['6100'],ids['6100'],ids['2101'],ids['2202'],ids['2202'],ids['1101'],ids['2202']])
 const [created]=await db.execute<any>("INSERT INTO payroll_employees(company_id,employee_number,name,hire_date,termination_date,ptkp_status,ter_category,basic_salary,fixed_allowance,bank_account_number,created_by) VALUES(1,'AUTO-EMP','Automation employee','2025-02-10','2025-02-28','TK/0','A',2800000,280000,'99991000',?)",[userId]);const employeeId=Number(created.insertId)
 const common={kind:'earning',channel:'payroll',basis:'nominal',rate:0,taxable:true,bpjs_base:false,expense_account_id:ids['6400'],contra_account_id:null,effective_from:'2025-02-01',effective_to:null,policy_reference:'Verified automation policy',is_active:true}
 const fixed=await master.save(1,null,{...common,code:'AUTO-FIXED',name:'Recurring fixed allowance'},actor),meal=await master.save(1,null,{...common,code:'AUTO-MEAL',name:'Recurring daily meal',basis:'attendance',rate:10000},actor),overtime=await master.save(1,null,{...common,code:'AUTO-OT',name:'Recurring overtime',basis:'overtime',rate:20000},actor)
 const assign={employee_id:employeeId,component_id:fixed.id,amount:280000,effective_from:'2025-02-01',effective_to:null,prorate:true,is_active:true}
 const assignment=await automation.saveAssignment(1,null,assign,actor)
 await assert.rejects(()=>automation.saveAssignment(1,null,assign,actor))
 await assert.rejects(()=>automation.saveAssignment(999999,null,assign,actor))
 await automation.saveAssignment(1,null,{...assign,component_id:meal.id,amount:0},actor)
 await automation.saveAssignment(1,null,{...assign,component_id:overtime.id,amount:0},actor)
 const createdRun:any=await payroll.createRun(1,{period:'2025-02',pay_date:'2025-02-28',proration_method:'calendar'},actor),id=Number(createdRun.run.id),entryId=Number(createdRun.entries[0].id)
 assert.equal(createdRun.entries.length,1);assert.equal(createdRun.entries[0].custom_components.length,3)
 assert.equal(Number(createdRun.entries[0].custom_components.find((c:any)=>Number(c.component_id)===fixed.id).amount),190000)
 assert.equal((await automation.applyRecurring(1,id,actor)).added,0)
 const csv=(rows:string[])=>new File(['nomor_pegawai;tanggal;status;jam_lembur;keterangan\n'+rows.join('\n')], 'attendance.csv',{type:'text/csv'})
 const partial=csv(['AUTO-EMP;2025-02-10;hadir;2;Start'])
 await automation.apply(1,id,partial,actor);await automation.apply(1,id,partial,actor)
 const [dailyCount]=await db.query<any[]>('SELECT COUNT(*) count FROM payroll_attendance_days WHERE entry_id=?',[entryId]);assert.equal(Number(dailyCount[0].count),1)
 const incomplete:any=await payroll.detail(1,id);assert.ok(incomplete.validation.issues.some((i:any)=>i.code==='ATTENDANCE_INCOMPLETE'))
 assert.ok((await automation.preview(1,id,csv(['AUTO-EMP;2025-02-30;hadir;0;Bad date']))).invalid_rows>0)
 assert.ok((await automation.preview(1,id,csv(['AUTO-EMP;2025-02-10;hadir;0;', 'AUTO-EMP;2025-02-10;hadir;0;']))).invalid_rows>0)
 await assert.rejects(()=>automation.apply(1,id,csv(['AUTO-EMP;2025-02-10;hadir;0;', 'AUTO-EMP;2025-02-10;hadir;0;']),actor))
 await assert.rejects(()=>payroll.updateEntry(1,id,entryId,{present_days:2},actor))
 const rows=Array.from({length:19},(_,i)=>`AUTO-EMP;2025-02-${String(i+10).padStart(2,'0')};${i<17?'hadir':'absen'};${i===0?2:0};Verified`)
 await automation.apply(1,id,csv(rows),actor)
 await automation.configureRun(1,id,{proration_method:'calendar',working_weekdays:'1,2,3,4,5',prorate_bpjs:false},actor)
 const calculated:any=await payroll.calculate(1,id),e=calculated.entries[0]
 assert.equal(Number(e.paid_basic_salary),1900000);assert.equal(Number(e.paid_fixed_allowance),190000);assert.equal(Number(e.period_days),28);assert.equal(Number(e.eligible_days),19)
 assert.equal(Number(e.bpjs_salary_base),3080000)
 assert.equal(Number(e.present_days),17);assert.equal(Number(e.absent_days),2);assert.equal(Number(e.overtime_hours),2)
 assert.equal(Number(e.custom_components.find((c:any)=>Number(c.component_id)===meal.id).amount),170000)
 assert.equal(Number(e.custom_components.find((c:any)=>Number(c.component_id)===overtime.id).amount),40000)
 assert.equal(Number(e.gross_earnings),2490000)
 const repeated:any=await payroll.calculate(1,id);assert.equal(Number(repeated.run.total_gross),2490000)
 await payroll.reopen(1,id,'Verify BPJS proration policy',actor)
 await automation.configureRun(1,id,{proration_method:'calendar',working_weekdays:'1,2,3,4,5',prorate_bpjs:true},actor)
 const withBpjs:any=await payroll.calculate(1,id);assert.equal(Number(withBpjs.entries[0].bpjs_salary_base),2090000)
 await payroll.approve(1,id,{userId:approverId})
 await assert.rejects(()=>automation.apply(1,id,partial,actor))
 await assert.rejects(()=>automation.applyRecurring(1,id,actor))
 await assert.rejects(()=>automation.configureRun(1,id,{proration_method:'none',working_weekdays:'1,2,3,4,5',prorate_bpjs:false},actor))
 console.log('PASS Payroll automation: daily import, duplicate dates, corrections, coverage, recurring snapshots, repeatability, interval/tenant guards, calendar proration, BPJS policy and approved-run protection')
}
