import { db, transaction } from '../config/database'
import { seedCore } from './seeds/core.seed'
import { seedAccounts } from './seeds/accounts.seed'
import { seedMaster } from './seeds/master.seed'
await transaction(async (connection) => {
  await seedCore(connection)
  await seedAccounts(connection)
  await seedMaster(connection)
})
console.info(
  'Seeder selesai. Login: admin@financeerp.local / password — segera ganti password default.',
)
await db.end()
