import { addColumnIfMissing, type MigrationDatabase } from './helpers'
export const migration={name:'045_settlement_bank_currency',async up(db:MigrationDatabase){
  await db.query("INSERT IGNORE INTO currencies(code,name,symbol,is_active) VALUES('USD','US Dollar','$',TRUE)")
  for(const table of ['supplier_payments','customer_payments']){
    await addColumnIfMissing(db,table,'bank_currency','CHAR(3) NULL')
    await db.query(`UPDATE ${table} p LEFT JOIN bank_accounts b ON b.id=p.bank_account_id AND b.company_id=p.company_id SET p.bank_currency=COALESCE(b.currency,p.currency) WHERE p.bank_currency IS NULL`)
  }
},async down(){throw new Error('Mata uang historis pelunasan harus dipertahankan')}}
