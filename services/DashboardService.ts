import { databaseStatus } from '../config/database'
import { DashboardRepository } from '../repositories/DashboardRepository'
export class DashboardService {
  constructor(private repository = new DashboardRepository()) {}
  health = async () =>
    ({
      success: true,
      service: 'finance-erp-be',
      database: (await databaseStatus()) ? 'connected' : 'disconnected',
    }) as const
  summary = (companyId: number) => this.repository.summary(companyId)
}
