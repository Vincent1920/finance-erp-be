import type { MigrationDatabase } from './helpers'

export const migration = {
  name: '020_year_end_posting_accounts',
  async up(db: MigrationDatabase) {
    await db.query(`
      INSERT INTO accounts(
        company_id,code,name,account_type,normal_balance,is_header,is_posting,is_active
      )
      SELECT c.id,'3201','Retained Earnings','equity','credit',FALSE,TRUE,TRUE
      FROM companies c
      WHERE NOT EXISTS(
        SELECT 1 FROM accounts a WHERE a.company_id=c.id AND a.code='3201'
      )
    `)
    await db.query(`
      INSERT INTO accounts(
        company_id,code,name,account_type,normal_balance,is_header,is_posting,is_active
      )
      SELECT c.id,'3301','Current Year Earnings','equity','credit',FALSE,TRUE,TRUE
      FROM companies c
      WHERE NOT EXISTS(
        SELECT 1 FROM accounts a WHERE a.company_id=c.id AND a.code='3301'
      )
    `)
  },
  async down(db: MigrationDatabase) {
    await db.query(`
      DELETE a FROM accounts a
      WHERE a.code IN('3201','3301')
        AND NOT EXISTS(SELECT 1 FROM journal_lines jl WHERE jl.account_id=a.id)
        AND NOT EXISTS(
          SELECT 1 FROM year_end_closings y
          WHERE y.current_year_earnings_account_id=a.id OR y.retained_earnings_account_id=a.id
        )
    `)
  },
}
