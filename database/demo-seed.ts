import { db } from '../config/database'
import { runDemoSeed } from './seeds/demo.seed'

if (import.meta.main) {
  try {
    await runDemoSeed()
  } finally {
    await db.end()
  }
}
