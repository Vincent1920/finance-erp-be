import { migration as core } from './001_core'
import { migration as master } from './002_master'
import { migration as accounting } from './003_accounting_transactions'
import { migration as foundationLifecycle } from './004_foundation_lifecycle'
import { migration as salesPurchaseInventory } from './005_sales_purchase_inventory'
import { migration as financeWorkflowReporting } from './006_finance_workflow_reporting'
import { migration as systemOpeningControls } from './007_system_opening_and_controls'

export const migrations = [
  core,
  master,
  accounting,
  foundationLifecycle,
  salesPurchaseInventory,
  financeWorkflowReporting,
  systemOpeningControls,
]
