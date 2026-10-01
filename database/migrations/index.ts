import { migration as core } from './001_core'
import { migration as master } from './002_master'
import { migration as accounting } from './003_accounting_transactions'
import { migration as foundationLifecycle } from './004_foundation_lifecycle'
import { migration as salesPurchaseInventory } from './005_sales_purchase_inventory'
import { migration as financeWorkflowReporting } from './006_finance_workflow_reporting'
import { migration as systemOpeningControls } from './007_system_opening_and_controls'
import { migration as dataImportWorkflow } from './008_data_import_workflow'
import { migration as operationalCompletion } from './009_operational_completion'
import { migration as itemSmallestUnit } from './010_item_smallest_unit'
import { migration as phaseOneTwoControls } from './011_phase_one_two_controls'
import { migration as paymentWorkspace } from './012_payment_workspace'
import { migration as taxReconciliation } from './013_tax_reconciliation'
import { migration as indonesianTaxWorkspaces } from './014_indonesian_tax_workspaces'
import { migration as taxCodeReportingType } from './015_tax_code_reporting_type'
import { migration as payroll } from './016_payroll'
import { migration as purchaseLineWithholding } from './017_purchase_line_withholding'
import { migration as companyIdentity } from './018_company_identity'
import { migration as payrollControls } from './019_payroll_controls'
import { migration as yearEndPostingAccounts } from './020_year_end_posting_accounts'
import { migration as recurringJournalAutomation } from './021_recurring_journal_automation'

export const migrations = [
  core,
  master,
  accounting,
  foundationLifecycle,
  salesPurchaseInventory,
  financeWorkflowReporting,
  systemOpeningControls,
  dataImportWorkflow,
  operationalCompletion,
  itemSmallestUnit,
  phaseOneTwoControls,
  paymentWorkspace,
  taxReconciliation,
  indonesianTaxWorkspaces,
  taxCodeReportingType,
  payroll,
  purchaseLineWithholding,
  companyIdentity,
  payrollControls,
  yearEndPostingAccounts,
  recurringJournalAutomation,
]
