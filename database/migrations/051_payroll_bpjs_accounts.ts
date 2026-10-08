import { addColumnIfMissing, type MigrationDatabase } from './helpers'
export const migration={name:'051_payroll_bpjs_accounts',async up(db:MigrationDatabase){
 for(const field of ['health_employer_expense_account_id','employment_employer_expense_account_id'])await addColumnIfMissing(db,'payroll_policies',field,'BIGINT UNSIGNED NULL')
},async down(){throw new Error('Preserve payroll account mapping history')}}
