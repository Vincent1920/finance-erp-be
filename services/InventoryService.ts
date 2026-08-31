import { InventoryRepository } from '../repositories/InventoryRepository'

export class InventoryService {
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
      item_id: number
      warehouse_id?: number
      date_from: string
      date_to: string
      page?: string
      limit?: string
    },
  ) {
    return this.repository.card(companyId, {
      itemId: query.item_id,
      warehouseId: query.warehouse_id,
      dateFrom: query.date_from,
      dateTo: query.date_to,
      page: query.page,
      limit: query.limit,
    })
  }
}
