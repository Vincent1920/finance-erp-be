import type { MigrationDatabase } from './helpers'
export const migration={name:'050_simple_payroll',async up(db:MigrationDatabase){
 // Only editable periods are converted; approved payroll retains its historical calculation.
 await db.query(`UPDATE payroll_runs r SET r.status='draft',r.calculated_at=NULL WHERE r.status='calculated' AND (r.proration_method<>'none' OR EXISTS(SELECT 1 FROM payroll_entries e JOIN payroll_entry_components c ON c.entry_id=e.id WHERE e.run_id=r.id AND (c.recurring_assignment_id IS NOT NULL OR JSON_UNQUOTE(JSON_EXTRACT(c.snapshot,'$.basis'))<>'nominal')))`)
 await db.query("UPDATE payroll_runs SET proration_method='none',prorate_bpjs=FALSE WHERE status IN ('draft','calculated')")
 await db.query(`UPDATE payroll_entry_components c JOIN payroll_entries e ON e.id=c.entry_id JOIN payroll_runs r ON r.id=e.run_id SET c.recurring_assignment_id=NULL,c.quantity=1,c.snapshot=JSON_SET(JSON_REMOVE(c.snapshot,'$.recurring_metadata'),'$.basis','nominal','$.rate',0) WHERE r.status IN ('draft','calculated')`)
 await db.query("UPDATE payroll_components SET basis='nominal',rate=0,version=version+1 WHERE basis<>'nominal'")
},async down(){throw new Error('Preserve historical payroll calculations')}}
