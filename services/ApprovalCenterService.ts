import type { RowDataPacket } from 'mysql2/promise'
import { db } from '../config/database'

export type ApprovalDocumentType = 'sales_invoice' | 'purchase_invoice' | 'journal'

const definitions: Record<ApprovalDocumentType, { label: string; detailBase: string; permission: string }> = {
  sales_invoice: { label: 'Invoice Penjualan', detailBase: '/sales/invoices', permission: 'sales-invoices.approve' },
  purchase_invoice: { label: 'Invoice Pembelian', detailBase: '/purchases/invoices', permission: 'purchase-invoices.approve' },
  journal: { label: 'Jurnal Umum', detailBase: '/accounting/journals', permission: 'accounting.approve' },
}

export class ApprovalCenterService {
  async queue(companyId: number, filters: { type?: string; search?: string }) {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT * FROM (
        SELECT 'sales_invoice' document_type,si.id,si.invoice_number document_number,si.invoice_date document_date,
          si.grand_total amount,si.currency,c.name partner_name,si.reference,si.submitted_at,si.submitted_by,
          submitter.name submitted_by_name,creator.name created_by_name,
          (SELECT COUNT(*) FROM attachments a WHERE a.company_id=si.company_id AND a.entity_type='sales_invoice' AND a.entity_id=si.id AND a.deleted_at IS NULL) attachment_count
        FROM sales_invoices si JOIN customers c ON c.id=si.customer_id
          LEFT JOIN users submitter ON submitter.id=si.submitted_by LEFT JOIN users creator ON creator.id=si.created_by
        WHERE si.company_id=? AND si.status='pending_approval'
        UNION ALL
        SELECT 'purchase_invoice',pi.id,pi.invoice_number,pi.invoice_date,pi.grand_total,pi.currency,s.name,pi.reference,pi.submitted_at,pi.submitted_by,
          submitter.name,creator.name,
          (SELECT COUNT(*) FROM attachments a WHERE a.company_id=pi.company_id AND a.entity_type='purchase_invoice' AND a.entity_id=pi.id AND a.deleted_at IS NULL)
        FROM purchase_invoices pi JOIN suppliers s ON s.id=pi.supplier_id
          LEFT JOIN users submitter ON submitter.id=pi.submitted_by LEFT JOIN users creator ON creator.id=pi.created_by
        WHERE pi.company_id=? AND pi.status='pending_approval'
        UNION ALL
        SELECT 'journal',j.id,j.journal_number,j.journal_date,j.total_debit,j.currency,NULL,j.reference,j.submitted_at,j.submitted_by,
          submitter.name,creator.name,
          (SELECT COUNT(*) FROM attachments a WHERE a.company_id=j.company_id AND a.entity_type='journal' AND a.entity_id=j.id AND a.deleted_at IS NULL)
        FROM journals j LEFT JOIN users submitter ON submitter.id=j.submitted_by LEFT JOIN users creator ON creator.id=j.created_by
        WHERE j.company_id=? AND j.status='pending_approval'
      ) queue ORDER BY COALESCE(submitted_at,document_date),document_type,id`,
      [companyId, companyId, companyId],
    )
    const requestedType = filters.type && filters.type !== 'all' ? filters.type : null
    const search = filters.search?.trim().toLocaleLowerCase('id-ID') ?? ''
    const filtered = rows.filter((row) => {
      if (requestedType && row.document_type !== requestedType) return false
      if (!search) return true
      return [row.document_number, row.partner_name, row.reference, row.submitted_by_name]
        .some((value) => String(value ?? '').toLocaleLowerCase('id-ID').includes(search))
    })
    const mapped = filtered.map((row) => {
      const type = row.document_type as ApprovalDocumentType
      const definition = definitions[type]
      return {
        ...row,
        id: Number(row.id),
        submitted_by: row.submitted_by ? Number(row.submitted_by) : null,
        amount: Number(row.amount ?? 0),
        attachment_count: Number(row.attachment_count ?? 0),
        type_label: definition.label,
        detail_url: `${definition.detailBase}/${row.id}`,
        approve_permission: definition.permission,
      }
    })
    const summary = Object.entries(definitions).map(([type, definition]) => {
      const typeRows = rows.filter((row) => row.document_type === type)
      return {
        type,
        label: definition.label,
        count: typeRows.length,
        amount: typeRows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0),
      }
    })
    return {
      rows: mapped,
      total: mapped.length,
      totalAmount: mapped.reduce((sum, row) => sum + row.amount, 0),
      missingEvidence: mapped.filter((row) => row.attachment_count === 0).length,
      summary,
    }
  }
}
