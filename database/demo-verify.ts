import { db } from '../config/database'
import { verifyDemoData } from './seeds/demo.seed'

if (import.meta.main) {
  try {
    const result = await verifyDemoData()
    console.info(JSON.stringify(result, null, 2))
  } finally {
    await db.end()
  }
}
