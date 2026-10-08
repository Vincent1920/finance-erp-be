import { Hono } from 'hono'
import type { Context } from 'hono'
import { OperationsController } from '../controllers/OperationsController'
import { operationContext } from '../controllers/OperationsController'
import { CancelledDocumentService, cancelledDocuments } from '../services/CancelledDocumentService'
import { positiveIdSchema } from '../validators/common.validator'
import { ok } from '../utils/response'
import { requirePermission } from '../middleware/permission.middleware'
import { requireRole, requirePlatformOperator, requireRestoreMaintenance } from '../middleware/role.middleware'
const route = new Hono(),
  controller = new OperationsController()
route.post('/tax-reconciliation/payments',requirePermission('tax-reconciliation.update'),controller.taxPayment)
route.post('/tax-reconciliation/amendment',requirePermission('tax-reconciliation.lock'),controller.taxAmendment)
route.get('/tax-reconciliation/versions/:id',requirePermission('tax-reconciliation.view'),controller.taxVersion)
route.get(
  '/tax-reconciliation',
  requirePermission('tax-reconciliation.view'),
  controller.taxReconciliation,
)
route.post(
  '/tax-reconciliation/import',
  requirePermission('tax-reconciliation.import'),
  controller.taxReportImport,
)
route.post(
  '/tax-reconciliation/import-internal',
  requirePermission('tax-reconciliation.import'),
  controller.taxInternalImport,
)
route.put(
  '/tax-reconciliation/document',
  requirePermission('tax-reconciliation.update'),
  controller.taxDocumentLink,
)
route.put(
  '/tax-reconciliation/resolution',
  requirePermission('tax-reconciliation.update'),
  controller.taxResolution,
)
route.put(
  '/tax-reconciliation/status',
  requirePermission('tax-reconciliation.lock'),
  controller.taxPeriodStatus,
)
route.get('/budgets', requirePermission('budgets.view'), controller.budgets)
route.post('/budgets', requirePermission('budgets.create'), controller.budgetCreate)
route.get('/budgets/:id', requirePermission('budgets.view'), controller.budgetDetail)
route.post('/budget-approve', requirePermission('budgets.approve'), controller.budgetApprove)
route.get('/cash-book', requirePermission('cash-book.view'), controller.cashBook)
route.get('/bank-statements', requirePermission('bank-statements.view'), controller.statements)
route.post(
  '/bank-statements',
  requirePermission('bank-statements.create'),
  controller.statementCreate,
)
route.post('/bank-match', requirePermission('bank-reconciliations.update'), controller.bankMatch)
route.post(
  '/bank-match-batch',
  requirePermission('bank-reconciliations.update'),
  controller.bankMatchBatch,
)
route.post(
  '/bank-unmatch',
  requirePermission('bank-reconciliations.update'),
  controller.bankUnmatch,
)
route.get(
  '/bank-match-suggestions',
  requirePermission('bank-reconciliations.view'),
  controller.bankSuggestions,
)
route.get(
  '/bank-matching-rules',
  requirePermission('bank-reconciliations.view'),
  controller.bankMatchingRules,
)
route.put(
  '/bank-matching-rules',
  requirePermission('bank-reconciliations.update'),
  controller.bankMatchingRuleSave,
)
route.delete(
  '/bank-matching-rules/:id',
  requirePermission('bank-reconciliations.update'),
  controller.bankMatchingRuleDelete,
)
route.get(
  '/bank-import-mappings',
  requirePermission('bank-statements.view'),
  controller.bankImportMappings,
)
route.put(
  '/bank-import-mappings',
  requirePermission('bank-statements.create'),
  controller.bankImportMappingSave,
)
route.delete(
  '/bank-import-mappings/:id',
  requirePermission('bank-statements.create'),
  controller.bankImportMappingDelete,
)
route.get('/print-template', controller.printTemplate)
route.put('/print-template', requirePermission('settings.update'), controller.printTemplateSave)
route.get('/assets', requirePermission('fixed-assets.view'), controller.assets)
route.get('/assets/:id/history', requirePermission('fixed-assets.view'), controller.assetHistory)
route.post(
  '/assets',
  requirePermission('fixed-assets.create'),
  requirePermission('fixed-assets.post'),
  controller.assetCreate,
)
route.post('/depreciation', requirePermission('depreciation.post'), controller.depreciate)
route.post(
  '/depreciation/:id/reverse',
  requirePermission('depreciation.reverse'),
  controller.depreciationReverse,
)
route.post(
  '/assets/:id/reverse',
  requirePermission('fixed-assets.reverse'),
  controller.assetReverse,
)
route.get(
  '/purchase-returns',
  requirePermission('purchase-returns.view'),
  controller.purchaseReturns,
)
route.post(
  '/purchase-returns',
  requirePermission('purchase-returns.create'),
  requirePermission('purchase-returns.post'),
  controller.purchaseReturn,
)
route.post(
  '/purchase-returns/:id/reverse',
  requirePermission('purchase-returns.reverse'),
  controller.purchaseReturnReverse,
)
for (const kind of Object.keys(cancelledDocuments) as Array<keyof typeof cancelledDocuments>) {
  route.delete(
    `/cancelled/${kind}/:id`,
    requirePermission(cancelledDocuments[kind].permission),
    async (c: Context) =>
      ok(
        c,
        await new CancelledDocumentService().remove(
          c.get('user').companyId,
          kind,
          positiveIdSchema.parse(c.req.param('id')),
          operationContext(c),
        ),
      ),
  )
}
route.get('/stock-transfers', requirePermission('stock-transfers.view'), controller.stockList(true))
route.post(
  '/stock-transfers',
  requirePermission('stock-transfers.create'),
  requirePermission('stock-transfers.post'),
  controller.stockPost(true),
)
route.post(
  '/stock-transfers/:id/reverse',
  requirePermission('stock-transfers.reverse'),
  controller.stockReverse(true),
)
route.get(
  '/stock-adjustments',
  requirePermission('stock-adjustments.view'),
  controller.stockList(false),
)
route.post(
  '/stock-adjustments',
  requirePermission('stock-adjustments.create'),
  requirePermission('stock-adjustments.post'),
  controller.stockPost(false),
)
route.post(
  '/stock-adjustments/:id/reverse',
  requirePermission('stock-adjustments.reverse'),
  controller.stockReverse(false),
)
route.get('/items/:itemId/units', requirePermission('items.view'), controller.itemUnits)
route.put('/items/:itemId/units', requirePermission('items.update'), controller.itemUnitsSave)
route.get(
  '/receivable-settlements',
  requirePermission('customer-payments.view'),
  controller.settlements(true),
)
route.post(
  '/receivable-settlements',
  requirePermission('customer-payments.create'),
  requirePermission('customer-payments.post'),
  controller.settle(true),
)
route.post(
  '/receivable-settlements/:id/reverse',
  requirePermission('customer-payments.reverse'),
  controller.settlementReverse(true),
)
route.delete(
  '/receivable-settlements/:id',
  requirePermission('customer-payments.delete'),
  controller.settlementDelete(true),
)
route.get(
  '/payable-settlements',
  requirePermission('supplier-payments.view'),
  controller.settlements(false),
)
route.post(
  '/payable-settlements',
  requirePermission('supplier-payments.create'),
  requirePermission('supplier-payments.post'),
  controller.settle(false),
)
route.post(
  '/payable-settlements/:id/reverse',
  requirePermission('supplier-payments.reverse'),
  controller.settlementReverse(false),
)
route.delete(
  '/payable-settlements/:id',
  requirePermission('supplier-payments.delete'),
  controller.settlementDelete(false),
)
route.get(
  '/customer-credits',
  requirePermission('customer-payments.view'),
  controller.credits(true),
)
route.post(
  '/customer-credits/apply',
  requirePermission('customer-payments.post'),
  controller.creditApply(true),
)
route.post(
  '/customer-credits/refund',
  requirePermission('customer-payments.post'),
  controller.creditRefund(true),
)
route.get(
  '/supplier-credits',
  requirePermission('supplier-payments.view'),
  controller.credits(false),
)
route.post(
  '/supplier-credits/apply',
  requirePermission('supplier-payments.post'),
  controller.creditApply(false),
)
route.post(
  '/supplier-credits/refund',
  requirePermission('supplier-payments.post'),
  controller.creditRefund(false),
)
route.post(
  '/credit-applications/:id/reverse',
  requirePermission('accounting.reverse'),
  controller.creditReverse,
)
route.get('/saved-views', controller.savedViews)
route.put('/saved-views', controller.savedViewSave)
route.delete('/saved-views/:id', controller.savedViewDelete)
route.get(
  '/backups',
  requirePlatformOperator,
  requireRole('super-admin'),
  requirePermission('backups.view'),
  controller.backups,
)
route.post(
  '/backups',
  requirePlatformOperator,
  requireRole('super-admin'),
  requirePermission('backups.create'),
  controller.backupCreate,
)
route.get(
  '/backups/:id/download',
  requirePlatformOperator,
  requireRole('super-admin'),
  requirePermission('backups.view'),
  controller.backupDownload,
)
route.post(
  '/backups/restore',
  requireRestoreMaintenance,
  requirePlatformOperator,
  requireRole('super-admin'),
  requirePermission('backups.restore'),
  controller.backupRestore,
)
export default route
