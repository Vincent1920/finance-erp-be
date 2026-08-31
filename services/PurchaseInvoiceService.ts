import { InvoiceRepository } from '../repositories/InvoiceRepository'
import type { QueryExecutor } from '../types/database'
import { ValidationError } from '../utils/AppError'
import { AuditService } from './AuditService'
import { BusinessValidationService } from './BusinessValidationService'
import {
  duplicateInvoiceError,
  importedPurchaseInvoiceSchema,
  importedStatus,
  prepareImportedInvoice,
  type CreatedImportedInvoice,
  type ImportedPurchaseInvoiceInput,
  type InvoiceMutationContext,
} from './InvoiceDomainSupport'

export type {
  CreatedImportedInvoice,
  ImportedPurchaseInvoiceInput,
  InvoiceMutationContext,
} from './InvoiceDomainSupport'

export class PurchaseInvoiceService {
  constructor(
    private repository = new InvoiceRepository(),
    private validation = new BusinessValidationService(),
    private audit = new AuditService(),
  ) {}

  /**
   * Creates one fully grouped imported purchase invoice on the caller-owned transaction.
   * This operation never posts a journal or changes inventory.
   */
  async createImported(
    connection: QueryExecutor,
    companyId: number,
    input: ImportedPurchaseInvoiceInput,
    context: InvoiceMutationContext,
  ): Promise<CreatedImportedInvoice> {
    if (!Number.isSafeInteger(companyId) || companyId <= 0) {
      throw new ValidationError('Company invoice tidak valid')
    }
    if (!Number.isSafeInteger(context.userId) || context.userId <= 0) {
      throw new ValidationError('User pembuat invoice tidak valid')
    }

    const parsed = importedPurchaseInvoiceSchema.parse(input)
    const duplicate = await this.repository.findPurchaseDuplicate(
      connection,
      companyId,
      parsed.invoiceNumber,
      parsed.supplierId,
      parsed.supplierInvoiceNumber,
    )
    if (duplicate) throw duplicateInvoiceError('purchase', parsed.invoiceNumber)

    const prepared = await prepareImportedInvoice(
      connection,
      companyId,
      'purchase',
      {
        invoiceNumber: parsed.invoiceNumber,
        invoiceDate: parsed.invoiceDate,
        dueDate: parsed.dueDate,
        partyId: parsed.supplierId,
        warehouseId: parsed.warehouseId,
        currency: parsed.currency,
        exchangeRate: parsed.exchangeRate,
        lines: parsed.lines.map(({ expenseAccountId, ...line }) => ({
          ...line,
          accountId: expenseAccountId,
        })),
      },
      this.repository,
      this.validation,
    )
    const status = importedStatus(parsed.importAs)
    const id = await this.repository.insertPurchase(connection, {
      companyId,
      invoiceNumber: parsed.invoiceNumber,
      supplierInvoiceNumber: parsed.supplierInvoiceNumber,
      invoiceDate: parsed.invoiceDate,
      dueDate: parsed.dueDate,
      supplierId: parsed.supplierId,
      warehouseId: prepared.warehouseId,
      reference: parsed.reference,
      notes: parsed.notes,
      currency: parsed.currency,
      exchangeRate: parsed.exchangeRate,
      status,
      accountingPeriodId: prepared.accountingPeriodId,
      userId: context.userId,
      totals: prepared.totals,
      lines: prepared.lines,
    })

    await this.audit.log(connection, {
      companyId,
      userId: context.userId,
      module: 'purchase-invoices',
      action: 'create_imported',
      recordType: 'purchase_invoice',
      recordId: id,
      recordNumber: parsed.invoiceNumber,
      newValue: {
        status,
        supplierId: parsed.supplierId,
        invoiceDate: parsed.invoiceDate,
        grandTotal: prepared.totals.grandTotal,
      },
      requestId: context.requestId,
      ip: context.ip,
      metadata: { source: 'data_import', lineCount: prepared.lines.length },
    })

    return { id, invoiceNumber: parsed.invoiceNumber, status, totals: prepared.totals }
  }
}
