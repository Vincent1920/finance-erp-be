import { EntityRepository, type EntityTable } from '../repositories/EntityRepository'
import { AppError } from '../utils/AppError'
export class EntityService {
  private repo
  constructor(table: EntityTable) {
    this.repo = new EntityRepository(table)
  }
  list(companyId: number, query: { page?: string; limit?: string; search?: string }) {
    return this.repo.list(companyId, query)
  }
  async get(id: number, companyId: number) {
    const row = await this.repo.find(id, companyId)
    if (!row) throw new AppError('Data tidak ditemukan', 404)
    return row
  }
  create(companyId: number, data: Record<string, unknown>) {
    return this.repo.create(companyId, data)
  }
  async update(id: number, companyId: number, data: Record<string, unknown>) {
    await this.get(id, companyId)
    return this.repo.update(id, companyId, data)
  }
  async remove(id: number, companyId: number) {
    await this.get(id, companyId)
    await this.repo.remove(id, companyId)
  }
}
