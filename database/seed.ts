import { db, transaction } from '../config/database'
import { runDemoNegativeTests } from './demo-negative'
import { runDemoSmoke } from './demo-smoke'
import { seedCore } from './seeds/core.seed'
import { runDemoSeed } from './seeds/demo.seed'

const line = '='.repeat(44)

try {
  if (process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production')
    throw new Error('Database demo seeding tidak boleh dijalankan di production')

  console.info(`\n${line}\nFINORA DATABASE SEED\n${line}`)
  console.info('\n[1/5] Core Data')
  await transaction(async (connection) => {
    await seedCore(connection)
  })
  console.info('✓ Company, demo admin, RBAC, and accounting periods')

  console.info('\n[2/5] Master & Transaction Demo')
  const verification = await runDemoSeed({ printSummary: false })
  for (const [label, count] of Object.entries(verification.counts))
    console.info(`✓ ${label.padEnd(25)} ${count}`)

  console.info('\n[3/5] Accounting & Inventory Verification')
  console.info(`✓ Posted Debit = Posted Credit (${verification.postedDebit})`)
  console.info(`✓ Negative Inventory = ${verification.negativeInventory}`)
  console.info(`✓ AR Difference = ${verification.arMismatch}`)
  console.info(`✓ AP Difference = ${verification.apMismatch}`)
  console.info(`✓ Inventory Difference = ${verification.inventoryMismatch}`)
  console.info(`✓ Orphan Records = ${verification.orphanRecords}`)
  console.info(`✓ Trial Balance Difference = ${verification.trialBalanceDifference}`)
  console.info(`✓ Balance Sheet Difference = ${verification.balanceSheetDifference}`)

  console.info('\n[4/5] Smoke Test')
  await runDemoSmoke()

  console.info('\n[5/5] Negative Safety Test')
  await runDemoNegativeTests()

  console.info(`\n${line}\nSEED COMPLETED SUCCESSFULLY\n${line}`)
  console.info('\nDEMO LOGIN')
  console.info('Email: demo.admin@finora.local')
  console.info('Password: DemoFinance2026!')
} catch (error) {
  console.error(`\n${line}\nSEED FAILED\n${line}`)
  throw error
} finally {
  await db.end()
}
