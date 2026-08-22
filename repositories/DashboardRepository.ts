import type { RowDataPacket } from 'mysql2'

import { db } from '../config/database'

export interface DashboardSummary {
  customers: number
  suppliers: number
  items: number
  postedJournals: number
}

interface DashboardSummaryRow extends RowDataPacket {
  customers: number
  suppliers: number
  items: number
  postedJournals: number
}

export class DashboardRepository {
  async summary(companyId: number): Promise<DashboardSummary> {
    const [rows] = await db.execute<DashboardSummaryRow[]>(
      `SELECT
         (SELECT COUNT(*) FROM customers WHERE company_id = ?) AS customers,
         (SELECT COUNT(*) FROM suppliers WHERE company_id = ?) AS suppliers,
         (SELECT COUNT(*) FROM items WHERE company_id = ?) AS items,
         (
           SELECT COUNT(*)
           FROM journals
           WHERE company_id = ? AND status = 'posted'
         ) AS postedJournals`,
      [companyId, companyId, companyId, companyId],
    )

    const row = rows[0]

    return {
      customers: Number(row?.customers ?? 0),
      suppliers: Number(row?.suppliers ?? 0),
      items: Number(row?.items ?? 0),
      postedJournals: Number(row?.postedJournals ?? 0),
    }
  }
}
