import { InventoryRepository } from '../repositories/InventoryRepository'
import { db } from '../config/database'
import type { RowDataPacket } from 'mysql2/promise'
import type { QueryExecutor } from '../types/database'

export class InventoryService {
  async summary(companyId: number, query: {date_from:string;date_to:string;item_id?:number;item_ids?:number[];warehouse_id?:number}, connection: QueryExecutor = db) {
    const ids = query.item_ids?.length ? query.item_ids : query.item_id ? [query.item_id] : []
    const where = `${ids.length ? ` AND im.item_id IN (${ids.map(()=>'?').join(',')})` : ''}${query.warehouse_id ? ' AND im.warehouse_id=?' : ''}`
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT im.item_id,im.warehouse_id,i.sku,i.name item_name,w.code warehouse_code,w.name warehouse_name,u.symbol unit_symbol,c.base_currency report_currency,
      CAST(SUM(CASE WHEN im.movement_date<? THEN im.quantity_in-im.quantity_out ELSE 0 END) AS CHAR) opening_quantity,
      CAST(SUM(CASE WHEN im.movement_date>=? THEN im.quantity_in ELSE 0 END) AS CHAR) quantity_in,
      CAST(SUM(CASE WHEN im.movement_date>=? THEN im.quantity_out ELSE 0 END) AS CHAR) quantity_out,
      CAST(SUM(im.quantity_in-im.quantity_out) AS CHAR) chronological_quantity,
      CAST(SUM(CASE WHEN im.quantity_in>0 THEN im.total_cost ELSE -im.total_cost END) AS CHAR) chronological_value,
      SUM(CASE WHEN im.movement_date>=? THEN 1 ELSE 0 END) movements
      FROM inventory_movements im JOIN items i ON i.id=im.item_id AND i.company_id=im.company_id
      JOIN warehouses w ON w.id=im.warehouse_id AND w.company_id=im.company_id
      JOIN companies c ON c.id=im.company_id LEFT JOIN units u ON u.id=i.unit_id AND u.company_id=im.company_id
      WHERE im.company_id=? AND im.movement_date<=? ${where}
      GROUP BY im.item_id,im.warehouse_id,i.sku,i.name,w.code,w.name,u.symbol,c.base_currency
      HAVING opening_quantity<>0 OR movements>0 ORDER BY i.sku,w.code`,[query.date_from,query.date_from,query.date_from,query.date_from,companyId,query.date_to,...ids,...(query.warehouse_id?[query.warehouse_id]:[])])
    return rows
  }
  async valuation(companyId: number, date: string) {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT im.item_id,im.warehouse_id,i.sku,i.name item_name,w.code warehouse_code,w.name warehouse_name,i.minimum_stock,
       SUM(im.quantity_in-im.quantity_out) quantity,
       SUM(CASE WHEN im.quantity_in>0 THEN im.total_cost ELSE -im.total_cost END) inventory_value,
       MAX(im.movement_date) last_movement_date,
       DATEDIFF(?,MAX(im.movement_date)) inactive_days,
       SUM(CASE WHEN im.movement_date>DATE_SUB(?,INTERVAL 30 DAY) THEN im.quantity_in ELSE 0 END) incoming_30_days,
       SUM(CASE WHEN im.movement_date>DATE_SUB(?,INTERVAL 30 DAY) THEN im.quantity_out ELSE 0 END) outgoing_30_days
       FROM inventory_movements im JOIN items i ON i.id=im.item_id AND i.company_id=im.company_id
       JOIN warehouses w ON w.id=im.warehouse_id AND w.company_id=im.company_id
       WHERE im.company_id=? AND im.movement_date<=?
       GROUP BY im.item_id,im.warehouse_id,i.sku,i.name,w.code,w.name,i.minimum_stock ORDER BY i.sku,w.code`,
      [date,date,date,companyId,date],
    )
    return { as_of_date: date, rows }
  }
  constructor(private repository = new InventoryRepository()) {}

  overview(
    companyId: number,
    query: {
      page?: string
      limit?: string
      search?: string
      warehouse_id?: number
      item_id?: number
      status?: string
    },
  ) {
    return this.repository.overview(companyId, {
      page: query.page,
      limit: query.limit,
      search: query.search,
      warehouseId: query.warehouse_id,
      itemId: query.item_id,
      status: query.status,
    })
  }

  card(
    companyId: number,
    query: {
      item_id?: number
      item_ids?: number[]
      warehouse_id?: number
      date_from: string
      date_to: string
      page?: string
      limit?: string
      search?: string
    },
  ) {
    return this.repository.card(companyId, {
      itemId: query.item_id,
      itemIds: query.item_ids,
      warehouseId: query.warehouse_id,
      dateFrom: query.date_from,
      dateTo: query.date_to,
      page: query.page,
      limit: query.limit,
      search: query.search,
    })
  }
}
