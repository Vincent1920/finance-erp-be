import { ReportRepository } from '../repositories/ReportRepository'
export class ReportingService {
  constructor(private repository = new ReportRepository()) {}
  async trialBalance(companyId: number) {
    const accounts = await this.repository.trialBalance(companyId),
      debit = accounts.reduce((sum, row) => sum + row.movementDebit, 0),
      credit = accounts.reduce((sum, row) => sum + row.movementCredit, 0)
    return { accounts, totals: { debit, credit }, balanced: Math.abs(debit - credit) < 0.005 }
  }
}
