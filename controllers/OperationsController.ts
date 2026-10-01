import type { Context } from 'hono'
import { SettlementService } from '../services/SettlementService'
import {
  settlementSchema,
  settlementListSchema,
  stockOperationSchema,
  purchaseReturnSchema,
  reversalOperationSchema,
  creditActionSchema,
  itemUnitsSchema,
} from '../validators/operations.validator'
import { PurchaseReturnService } from '../services/PurchaseReturnService'
import { FixedAssetService } from '../services/FixedAssetService'
import { PrintTemplateService } from '../services/PrintTemplateService'
import { BankingService } from '../services/BankingService'
import { BudgetService } from '../services/BudgetService'
import { budgetSchema, budgetApprovalSchema } from '../validators/operations.validator'
import {
  bankingQuerySchema,
  statementSchema,
  bankMatchSchema,
  bankUnmatchSchema,
} from '../validators/operations.validator'
import { printTemplateSchema } from '../validators/operations.validator'
import { assetSchema, depreciationSchema } from '../validators/operations.validator'
import { isoDateSchema } from '../validators/common.validator'
import { StockOperationService } from '../services/StockOperationService'
import { CreditService } from '../services/CreditService'
import { SavedViewService } from '../services/SavedViewService'
import { savedViewSchema } from '../validators/operations.validator'
import { backupSchema, restoreSchema } from '../validators/operations.validator'
import { BackupService } from '../services/BackupService'
import { positiveIdSchema } from '../validators/common.validator'
import { ok } from '../utils/response'
import { requestIp } from '../utils/request-context'
import { TaxReconciliationService } from '../services/TaxReconciliationService'
import {
  taxPeriodStatusSchema,
  taxDocumentLinkSchema,
  taxReconciliationQuerySchema,
  taxReportImportSchema,
  taxResolutionSchema,
} from '../validators/tax-reconciliation.validator'
export const operationContext = (c: Context) => ({
  userId: c.get('user').id,
  requestId: c.get('requestId'),
  ip: requestIp(c),
})
export class OperationsController {
  taxReconciliation = async (c: Context) => {
    const query = taxReconciliationQuerySchema.parse(c.req.query())
    return ok(c, await new TaxReconciliationService().overview(
      c.get('user').companyId, query.period, query.scope,
    ))
  }
  taxReportImport = async (c: Context) => ok(c, await new TaxReconciliationService().importReport(
    c.get('user').companyId,
    taxReportImportSchema.parse(await c.req.json()),
    operationContext(c),
  ))
  taxInternalImport = async (c: Context) => ok(c, await new TaxReconciliationService().importInternal(
    c.get('user').companyId,
    taxReportImportSchema.parse(await c.req.json()),
    operationContext(c),
  ))
  taxDocumentLink = async (c: Context) => ok(c, await new TaxReconciliationService().linkDocument(
    c.get('user').companyId,
    taxDocumentLinkSchema.parse(await c.req.json()),
    operationContext(c),
  ))
  taxResolution = async (c: Context) => ok(c, await new TaxReconciliationService().resolve(
    c.get('user').companyId,
    taxResolutionSchema.parse(await c.req.json()),
    operationContext(c),
  ))
  taxPeriodStatus = async (c: Context) => {
    const input = taxPeriodStatusSchema.parse(await c.req.json())
    return ok(c, await new TaxReconciliationService().setStatus(
      c.get('user').companyId, input.period, input.status, operationContext(c),
    ))
  }
  budgets = async (c: Context) => ok(c, await new BudgetService().list(c.get('user').companyId))
  budgetCreate = async (c: Context) =>
    ok(
      c,
      await new BudgetService().create(
        c.get('user').companyId,
        budgetSchema.parse(await c.req.json()),
        operationContext(c),
      ),
    )
  budgetApprove = async (c: Context) =>
    ok(
      c,
      await new BudgetService().approve(
        c.get('user').companyId,
        budgetApprovalSchema.parse(await c.req.json()),
        operationContext(c),
      ),
    )
  budgetDetail = async (c: Context) =>
    ok(
      c,
      await new BudgetService().detail(
        c.get('user').companyId,
        positiveIdSchema.parse(c.req.param('id')),
        isoDateSchema.parse(c.req.query('as_of_date')),
      ),
    )
  cashBook = async (c: Context) =>
    ok(
      c,
      await new BankingService().cash(
        c.get('user').companyId,
        bankingQuerySchema.parse(c.req.query()),
      ),
    )
  statements = async (c: Context) =>
    ok(
      c,
      await new BankingService().statements(
        c.get('user').companyId,
        bankingQuerySchema.parse(c.req.query()),
      ),
    )
  statementCreate = async (c: Context) =>
    ok(
      c,
      await new BankingService().create(
        c.get('user').companyId,
        statementSchema.parse(await c.req.json()),
        operationContext(c),
      ),
    )
  bankMatch = async (c: Context) =>
    ok(
      c,
      await new BankingService().match(
        c.get('user').companyId,
        bankMatchSchema.parse(await c.req.json()),
        operationContext(c),
      ),
    )
  bankUnmatch = async (c: Context) =>
    ok(
      c,
      await new BankingService().unmatch(
        c.get('user').companyId,
        bankUnmatchSchema.parse(await c.req.json()),
        operationContext(c),
      ),
    )
  bankSuggestions = async (c: Context) => ok(c, await new BankingService().suggestions(
    c.get('user').companyId,
    bankingQuerySchema.parse(c.req.query()),
  ))
  printTemplate = async (c: Context) =>
    ok(c, await new PrintTemplateService().get(c.get('user').companyId, c.req.query('document_type') ?? 'sales_invoice'))
  printTemplateSave = async (c: Context) => {
    const parsed = printTemplateSchema.parse(await c.req.json())
    const { documentType, ...template } = parsed
    return ok(c, await new PrintTemplateService().save(
      c.get('user').companyId, documentType, template, operationContext(c),
    ))
  }
  assets = async (c: Context) =>
    ok(
      c,
      await new FixedAssetService().list(
        c.get('user').companyId,
        isoDateSchema.parse(c.req.query('as_of_date')),
      ),
    )
  assetCreate = async (c: Context) =>
    ok(
      c,
      await new FixedAssetService().create(
        c.get('user').companyId,
        assetSchema.parse(await c.req.json()),
        operationContext(c),
      ),
    )
  depreciate = async (c: Context) =>
    ok(
      c,
      await new FixedAssetService().depreciate(
        c.get('user').companyId,
        depreciationSchema.parse(await c.req.json()),
        operationContext(c),
      ),
    )
  depreciationReverse = async (c: Context) => ok(c, await new FixedAssetService().reverseDepreciation(
    c.get('user').companyId,
    positiveIdSchema.parse(c.req.param('id')),
    reversalOperationSchema.parse(await c.req.json()),
    operationContext(c),
  ))
  assetReverse = async (c: Context) => ok(c, await new FixedAssetService().reverseAsset(
    c.get('user').companyId,
    positiveIdSchema.parse(c.req.param('id')),
    reversalOperationSchema.parse(await c.req.json()),
    operationContext(c),
  ))
  purchaseReturns = async (c: Context) =>
    ok(c, await new PurchaseReturnService().list(c.get('user').companyId))
  purchaseReturn = async (c: Context) =>
    ok(
      c,
      await new PurchaseReturnService().post(
        c.get('user').companyId,
        purchaseReturnSchema.parse(await c.req.json()),
        operationContext(c),
      ),
    )
  purchaseReturnReverse = async (c: Context) =>
    ok(c, await new PurchaseReturnService().reverse(
      c.get('user').companyId,
      positiveIdSchema.parse(c.req.param('id')),
      reversalOperationSchema.parse(await c.req.json()),
      operationContext(c),
    ))
  stockList = (transfer: boolean) => async (c: Context) =>
    ok(c, await new StockOperationService().list(c.get('user').companyId, transfer))
  stockPost = (transfer: boolean) => async (c: Context) =>
    ok(
      c,
      await new StockOperationService().post(
        c.get('user').companyId,
        transfer,
        stockOperationSchema.parse(await c.req.json()),
        operationContext(c),
      ),
    )
  stockReverse = (transfer: boolean) => async (c: Context) =>
    ok(c, await new StockOperationService().reverse(
      c.get('user').companyId,
      transfer,
      positiveIdSchema.parse(c.req.param('id')),
      reversalOperationSchema.parse(await c.req.json()),
      operationContext(c),
    ))
  itemUnits = async (c: Context) => ok(c, await new StockOperationService().itemUnits(
    c.get('user').companyId,
    positiveIdSchema.parse(c.req.param('itemId')),
  ))
  itemUnitsSave = async (c: Context) => ok(c, await new StockOperationService().saveItemUnits(
    c.get('user').companyId,
    positiveIdSchema.parse(c.req.param('itemId')),
    itemUnitsSchema.parse(await c.req.json()),
    operationContext(c),
  ))
  settlements = (sales: boolean) => async (c: Context) =>
    ok(
      c,
      await new SettlementService().list(
        c.get('user').companyId,
        sales,
        (() => {
          const query = settlementListSchema.parse({
            invoice_id: c.req.query('invoice_id'),
            date_from: c.req.query('date_from'),
            date_to: c.req.query('date_to'),
            status: c.req.query('status'),
            search: c.req.query('search'),
          })
          return {
            invoiceId: query.invoice_id,
            dateFrom: query.date_from,
            dateTo: query.date_to,
            status: query.status,
            search: query.search,
          }
        })(),
      ),
    )
  settle = (sales: boolean) => async (c: Context) =>
    ok(
      c,
      await new SettlementService().post(
        c.get('user').companyId,
        sales,
        settlementSchema.parse(await c.req.json()),
        operationContext(c),
      ),
    )
  settlementReverse = (sales: boolean) => async (c: Context) =>
    ok(c, await new SettlementService().reverse(
      c.get('user').companyId,
      sales,
      positiveIdSchema.parse(c.req.param('id')),
      reversalOperationSchema.parse(await c.req.json()),
      operationContext(c),
    ))
  settlementDelete = (sales: boolean) => async (c: Context) =>
    ok(c, await new SettlementService().remove(
      c.get('user').companyId,
      sales,
      positiveIdSchema.parse(c.req.param('id')),
      operationContext(c),
    ))
  credits = (sales: boolean) => async (c: Context) =>
    ok(c, await new CreditService().list(
      c.get('user').companyId,
      sales,
      c.req.query('party_id') ? positiveIdSchema.parse(c.req.query('party_id')) : undefined,
    ))
  creditApply = (sales: boolean) => async (c: Context) =>
    ok(c, await new CreditService().apply(
      c.get('user').companyId,
      sales,
      creditActionSchema.parse(await c.req.json()),
      operationContext(c),
    ))
  creditRefund = (sales: boolean) => async (c: Context) =>
    ok(c, await new CreditService().refund(
      c.get('user').companyId,
      sales,
      creditActionSchema.parse(await c.req.json()),
      operationContext(c),
    ))
  creditReverse = async (c: Context) =>
    ok(c, await new CreditService().reverse(
      c.get('user').companyId,
      positiveIdSchema.parse(c.req.param('id')),
      reversalOperationSchema.parse(await c.req.json()),
      operationContext(c),
    ))
  savedViews = async (c: Context) => ok(c, await new SavedViewService().list(
    c.get('user').companyId,
    c.get('user').id,
    c.req.query('screen_key') ?? '',
  ))
  savedViewSave = async (c: Context) => ok(c, await new SavedViewService().save(
    c.get('user').companyId,
    c.get('user').id,
    savedViewSchema.parse(await c.req.json()),
  ))
  savedViewDelete = async (c: Context) => ok(c, await new SavedViewService().remove(
    c.get('user').companyId,
    c.get('user').id,
    positiveIdSchema.parse(c.req.param('id')),
  ))
  backups = async (c: Context) => ok(c, await new BackupService().list(c.get('user').companyId))
  backupCreate = async (c: Context) => ok(c, await new BackupService().create(c.get('user').companyId, backupSchema.parse(await c.req.json()).type, operationContext(c)))
  backupDownload = async (c: Context) => {
    const result = await new BackupService().file(c.get('user').companyId, positiveIdSchema.parse(c.req.param('id')))
    return c.body(await Bun.file(result.path).arrayBuffer(), 200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${result.backup.file_name}"` })
  }
  backupRestore = async (c: Context) => {
    const input = restoreSchema.parse(await c.req.json())
    return ok(c, await new BackupService().restore(c.get('user').companyId, input.backup_id, input.confirmation, operationContext(c)))
  }
}
