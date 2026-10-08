import { db } from '../config/database'
import type { RowDataPacket } from 'mysql2/promise'
import { ReportingService } from './ReportingService'
import { subtractDecimal, compareDecimal } from '../utils/decimal'

export class AccountingControlService {
  async overview(companyId: number, date: string) {
    const reports = new ReportingService()
    const checks: Array<{
      code: string
      label: string
      status: string
      difference?: string
      count?: number
      message?: string
      link: string
    }> = []
    let reconciliations: Array<
      Awaited<ReturnType<ReportingService['subledger']>>[number] & { sourceAvailable?: boolean }
    > = []
    const run = async (
      code: string,
      label: string,
      link: string,
      task: () => Promise<{
        difference?: string
        count?: number
        message?: string
        passed: boolean
      }>,
    ) => {
      try {
        const result = await task()
        checks.push({ code, label, link, ...result, status: result.passed ? 'passed' : 'failed' })
      } catch {
        checks.push({
          code,
          label,
          link,
          status: 'unavailable',
          message: 'Pemeriksaan belum berhasil. Buka laporan sumber untuk melihat penyebabnya.',
        })
      }
    }
    await run(
      'trial_balance',
      'Keseimbangan neraca saldo',
      '/accounting/trial-balance',
      async () => {
        const r = await reports.trialBalance(companyId, {
          dateFrom: `${date.slice(0, 4)}-01-01`,
          dateTo: date,
        })
        return { passed: r.balanced, difference: r.difference }
      },
    )
    await run(
      'balance_sheet',
      'Aset = liabilitas + ekuitas',
      '/reports/balance-sheet',
      async () => {
        const r = await reports.balanceSheet(companyId, date)
        return { passed: r.balanced, difference: r.difference }
      },
    )
    await run(
      'profit_link',
      'Laba berjalan pada neraca = laba rugi fiskal',
      '/reports/profit-loss',
      async () => {
        const b = await reports.balanceSheet(companyId, date),
          p = await reports.profitLoss(companyId, b.fiscalPeriod)
        const difference = subtractDecimal(
          String(b.sections.equity.currentYearEarnings),
          String(p.netProfit),
        )
        return { passed: compareDecimal(difference, '0') === 0, difference }
      },
    )
    await run(
      'journal_lines',
      'Jurnal posted sesuai baris dan seimbang',
      '/accounting/journals',
      async () => {
        const [r] = await db.execute<RowDataPacket[]>(
          `SELECT COUNT(*) n FROM (SELECT j.id FROM journals j LEFT JOIN journal_lines l ON l.journal_id=j.id WHERE j.company_id=? AND j.status IN('posted','reversed') AND j.journal_date<=? GROUP BY j.id,j.total_debit,j.total_credit HAVING COUNT(l.id)<2 OR COALESCE(SUM(l.debit),0)<>COALESCE(SUM(l.credit),0) OR COALESCE(SUM(l.debit),0)<>j.total_debit OR COALESCE(SUM(l.credit),0)<>j.total_credit) errors`,
          [companyId, date],
        )
        const count = Number(r[0]?.n ?? 0)
        return { passed: count === 0, count }
      },
    )
    await run(
      'subledger',
      'Piutang, utang, stok, bank, aset, dan payroll vs GL',
      '/reports/subledger',
      async () => {
        const sourceRows = await reports.subledger(companyId, date)
        const [missingBanks] = await db.execute<RowDataPacket[]>(
          `SELECT DISTINCT b.gl_account_id FROM bank_accounts b WHERE b.company_id=? AND b.is_active=TRUE AND b.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM bank_statements s WHERE s.company_id=b.company_id AND s.bank_account_id=b.id AND s.period_end<=?)`,
          [companyId, date],
        )
        const missingAccounts = new Set(missingBanks.map((r) => Number(r.gl_account_id)))
        reconciliations = sourceRows.map((r) => ({
          ...r,
          sourceAvailable: r.type !== 'bank' || !missingAccounts.has(r.accountId),
        }))
        const count = reconciliations.filter((r) => !r.balanced || !r.sourceAvailable).length
        return {
          passed: count === 0 && reconciliations.length > 0,
          count,
          message: missingAccounts.size
            ? `${missingAccounts.size} akun bank belum memiliki rekening koran sampai tanggal laporan; saldo sumber belum dapat diverifikasi.`
            : reconciliations.length
              ? 'Saldo dibandingkan per akun.'
              : 'Belum ada akun yang dapat dibandingkan.',
        }
      },
    )
    return { asOfDate: date, checkedAt: new Date().toISOString(), checks, reconciliations }
  }
}
