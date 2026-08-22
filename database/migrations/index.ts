import { migration as core } from './001_core'
import { migration as master } from './002_master'
import { migration as accounting } from './003_accounting_transactions'
export const migrations = [core, master, accounting]
