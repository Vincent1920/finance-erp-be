import {migration as coaHeaderPresentation} from './055_coa_header_presentation'
import {migration as coaPresentationOrder} from './054_coa_presentation_order'
import {migration as platformOperations} from './053_platform_operations'
import { migration as authSessions } from './052_auth_sessions'
import { migration as payrollBpjsAccounts } from './051_payroll_bpjs_accounts'
import { migration as simplePayroll } from './050_simple_payroll'
import { migration as payrollAutomation } from './049_payroll_automation'
import { migration as payrollComponents } from './048_payroll_components'
import {migration as departments} from './047_departments'
import { migration as baseCurrencyCatalog } from './046_base_currency_catalog'
import { migration as settlementBankCurrency } from './045_settlement_bank_currency'
import { migration as fxAssetPolicy } from './044_fx_asset_policy'
import { migration as accountingDatePolicy } from './043_accounting_date_policy'
import { migration as coaGovernance } from './042_coa_governance'
import { migration as core } from './001_core'
import { migration as workflowBypass } from './040_workflow_bypass'
import { migration as fifoCosting } from './041_fifo_costing'
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
import { migration as accountingSchedules } from './022_accounting_schedules'
import { migration as scheduleControls } from './023_schedule_controls'
import { migration as flexibleNumbering } from './024_flexible_numbering'
import { migration as settlementProcessingFee } from './025_settlement_processing_fee'
import { migration as companyPolicySettings } from './026_company_policy_settings'
import { migration as payrollEmployeeStatus } from './027_payroll_employee_status'
import { migration as reconciliationWorkspace } from './028_reconciliation_workspace'
import { migration as reconciliationCaseSnapshot } from './029_reconciliation_case_snapshot'
import { migration as payrollHistoryBankProfiles } from './030_payroll_history_bank_profiles'
import { migration as accountingCoreControls } from './031_accounting_core_controls'
import { migration as coaHierarchyFoundation } from './032_coa_hierarchy_foundation'
import { migration as equityWorkspace } from './033_equity_workspace'
import { migration as invoiceControlSnapshot } from './034_invoice_control_snapshot'
import { migration as taxFxActualControls } from './035_tax_fx_actual_controls'
import { migration as nativeCurrencyLedger } from './036_native_currency_ledger'
import { migration as printTemplateProfiles } from './037_print_template_profiles'
import { migration as userPreferences } from './038_user_preferences'
import { migration as reportExports } from './039_report_exports'

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
  accountingSchedules,
  scheduleControls,
  flexibleNumbering,
  settlementProcessingFee,
  companyPolicySettings,
  payrollEmployeeStatus,
  reconciliationWorkspace,
  reconciliationCaseSnapshot,
  payrollHistoryBankProfiles,
  accountingCoreControls,
  coaHierarchyFoundation,
  equityWorkspace,
  invoiceControlSnapshot,
  taxFxActualControls,
  nativeCurrencyLedger,
  printTemplateProfiles,
  userPreferences,
  reportExports,
  workflowBypass,
  fifoCosting,
  coaGovernance,
  accountingDatePolicy,
  fxAssetPolicy,
  settlementBankCurrency,
  baseCurrencyCatalog,
  departments,
  payrollComponents,
  payrollAutomation,
  simplePayroll,
  payrollBpjsAccounts,
  authSessions,
  platformOperations,
  coaPresentationOrder,
  coaHeaderPresentation,
]
