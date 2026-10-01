import type { RowDataPacket } from 'mysql2/promise'
import { transaction } from '../config/database'
import { ConflictError, NotFoundError } from '../utils/AppError'
import { AuditService } from './AuditService'
import type { PostingContext } from './PostingService'
export const cancelledDocuments = {
  journals: { table: 'journals', permission: 'accounting.delete' },
  'sales-orders': { table: 'sales_orders', permission: 'sales-orders.delete' },
  'sales-invoices': { table: 'sales_invoices', permission: 'sales-invoices.delete' },
  'sales-returns': { table: 'sales_returns', permission: 'sales-returns.delete' },
  'purchase-orders': { table: 'purchase_orders', permission: 'purchase-orders.delete' },
  'purchase-invoices': { table: 'purchase_invoices', permission: 'purchase-invoices.delete' },
  'purchase-returns': { table: 'purchase_returns', permission: 'purchase-returns.delete' },
  'customer-payments': { table: 'customer_payments', permission: 'customer-payments.delete' },
  'supplier-payments': { table: 'supplier_payments', permission: 'supplier-payments.delete' },
  'goods-receipts': { table: 'goods_receipts', permission: 'goods-receipts.delete' },
  'stock-transfers': { table: 'stock_transfers', permission: 'stock-transfers.delete' },
  'stock-adjustments': { table: 'stock_adjustments', permission: 'stock-adjustments.delete' },
} as const
export class CancelledDocumentService {
  remove(
    companyId: number,
    kind: keyof typeof cancelledDocuments,
    id: number,
    context: PostingContext,
  ) {
    return transaction(async (connection) => {
      const table = cancelledDocuments[kind].table
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT * FROM ${table} WHERE id=? AND company_id=? FOR UPDATE`,
        [id, companyId],
      )
      const row = rows[0]
      if (!row) throw new NotFoundError('Dokumen tidak ditemukan')
      if (row.status !== 'cancelled')
        throw new ConflictError('Hanya dokumen berstatus dibatalkan yang boleh dihapus')
      if (row.journal_id || row.reversal_journal_id || row.posted_at)
        throw new ConflictError('Dokumen yang pernah diposting harus dipertahankan untuk audit')
      const child =
        kind === 'purchase-invoices'
          ? ['purchase_invoice_lines', 'purchase_invoice_id']
          : kind === 'sales-invoices'
            ? ['sales_invoice_lines', 'sales_invoice_id']
            : null
      if (child) {
        const [lines] = await connection.execute<RowDataPacket[]>(
          `SELECT * FROM ${child[0]} WHERE ${child[1]}=? FOR UPDATE`,
          [id],
        )
        row.lines = lines
      }
      await new AuditService().log(connection, {
        companyId,
        userId: context.userId,
        module: kind,
        action: 'delete_cancelled',
        recordType: table,
        recordId: id,
        oldValue: row,
        requestId: context.requestId,
        ip: context.ip,
      })
      // Legacy invoice line foreign keys do not cascade. External references still prevent deletion.
      if (child) await connection.execute(`DELETE FROM ${child[0]} WHERE ${child[1]}=?`, [id])
      try {
        await connection.execute(
          `DELETE FROM ${table} WHERE id=? AND company_id=? AND status='cancelled'`,
          [id, companyId],
        )
      } catch (error) {
        if ((error as { code?: string }).code === 'ER_ROW_IS_REFERENCED_2')
          throw new ConflictError('Dokumen masih dirujuk transaksi lain dan tidak dapat dihapus')
        throw error
      }
      return { id, deleted: true }
    })
  }
}
