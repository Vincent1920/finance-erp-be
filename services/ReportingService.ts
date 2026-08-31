import { ReportRepository, type DateRange, type LedgerFilters } from '../repositories/ReportRepository'
import {
  addDecimal,
  compareDecimal,
  fromScaledInteger,
  subtractDecimal,
  sumScaled,
  toScaledInteger,
} from '../utils/decimal'

type ReportRow = Record<string, unknown>

const money = (value: unknown) => String(value ?? '0')
const signedDebit = (row: ReportRow) =>
  subtractDecimal(money(row.debit), money(row.credit))
const signedCredit = (row: ReportRow) =>
  subtractDecimal(money(row.credit), money(row.debit))

function total(values: Array<string | number>) {
  return fromScaledInteger(sumScaled(values))
}

export class ReportingService {
  constructor(private repository = new ReportRepository()) {}

  generalLedger(companyId: number, filters: LedgerFilters) {
    return this.repository.generalLedger(companyId, filters)
  }

  async trialBalance(companyId: number, range: DateRange) {
    const rows = await this.repository.trialBalance(companyId, range)
    const accounts = rows.map((row) => ({
      id: Number(row.id),
      code: String(row.code),
      name: String(row.name),
      accountType: String(row.account_type),
      normalBalance: row.normal_balance,
      openingDebit: money(row.opening_debit),
      openingCredit: money(row.opening_credit),
      periodDebit: money(row.period_debit),
      periodCredit: money(row.period_credit),
      endingDebit: money(row.ending_debit),
      endingCredit: money(row.ending_credit),
    }))
    const totals = {
      openingDebit: total(accounts.map((row) => row.openingDebit)),
      openingCredit: total(accounts.map((row) => row.openingCredit)),
      periodDebit: total(accounts.map((row) => row.periodDebit)),
      periodCredit: total(accounts.map((row) => row.periodCredit)),
      endingDebit: total(accounts.map((row) => row.endingDebit)),
      endingCredit: total(accounts.map((row) => row.endingCredit)),
    }

    return {
      range,
      accounts,
      totals,
      balanced:
        compareDecimal(totals.periodDebit, totals.periodCredit) === 0 &&
        compareDecimal(totals.endingDebit, totals.endingCredit) === 0,
      difference: subtractDecimal(totals.endingDebit, totals.endingCredit),
    }
  }

  async profitLoss(companyId: number, range: DateRange) {
    const rows = (await this.repository.accountMovements(companyId, range)) as ReportRow[]
    const accountRows = rows.map((row) => {
      const accountType = String(row.account_type)
      const amount = ['revenue', 'other_income'].includes(accountType)
        ? signedCredit(row)
        : signedDebit(row)
      return {
        accountId: Number(row.id),
        code: String(row.code),
        name: String(row.name),
        accountType,
        amount,
      }
    })
    const section = (types: string[]) => accountRows.filter((row) => types.includes(row.accountType))
    const revenue = section(['revenue'])
    const cogs = section(['cogs'])
    const otherIncome = section(['other_income'])
    const otherExpense = section(['other_expense'])
    const expenseRows = section(['expense'])
    const tax = expenseRows.filter((row) => /pajak|tax/i.test(row.name))
    const operatingExpenses = expenseRows.filter((row) => !tax.includes(row))
    const revenueTotal = total(revenue.map((row) => row.amount))
    const cogsTotal = total(cogs.map((row) => row.amount))
    const grossProfit = subtractDecimal(revenueTotal, cogsTotal)
    const operatingExpenseTotal = total(operatingExpenses.map((row) => row.amount))
    const operatingProfit = subtractDecimal(grossProfit, operatingExpenseTotal)
    const otherIncomeTotal = total(otherIncome.map((row) => row.amount))
    const otherExpenseTotal = total(otherExpense.map((row) => row.amount))
    const profitBeforeTax = addDecimal([
      operatingProfit,
      otherIncomeTotal,
      `-${otherExpenseTotal}`,
    ])
    const taxTotal = total(tax.map((row) => row.amount))
    const netProfit = subtractDecimal(profitBeforeTax, taxTotal)

    return {
      range,
      sections: {
        revenue: { accounts: revenue, total: revenueTotal },
        cogs: { accounts: cogs, total: cogsTotal },
        operatingExpenses: { accounts: operatingExpenses, total: operatingExpenseTotal },
        otherIncome: { accounts: otherIncome, total: otherIncomeTotal },
        otherExpense: { accounts: otherExpense, total: otherExpenseTotal },
        tax: { accounts: tax, total: taxTotal },
      },
      grossProfit,
      operatingProfit,
      profitBeforeTax,
      netProfit,
    }
  }

  async balanceSheet(companyId: number, asOfDate: string) {
    const rows = (await this.repository.accountBalancesAsOf(companyId, asOfDate)) as ReportRow[]
    const mapped = rows.map((row) => {
      const accountType = String(row.account_type)
      const amount = accountType === 'asset' ? signedDebit(row) : signedCredit(row)
      return {
        accountId: Number(row.id),
        code: String(row.code),
        name: String(row.name),
        accountType,
        amount,
      }
    })
    const assets = mapped.filter((row) => row.accountType === 'asset')
    const liabilities = mapped.filter((row) => row.accountType === 'liability')
    const equity = mapped.filter((row) => row.accountType === 'equity')
    const profitAccounts = mapped.filter((row) =>
      ['revenue', 'other_income', 'cogs', 'expense', 'other_expense'].includes(row.accountType),
    )
    const currentEarningsMinor = profitAccounts.reduce((sum, row) => {
      const value = toScaledInteger(row.amount)
      return ['revenue', 'other_income'].includes(row.accountType) ? sum + value : sum - value
    }, 0n)
    const currentYearEarnings = fromScaledInteger(currentEarningsMinor)
    const assetTotal = total(assets.map((row) => row.amount))
    const liabilityTotal = total(liabilities.map((row) => row.amount))
    const equityAccountTotal = total(equity.map((row) => row.amount))
    const equityTotal = addDecimal([equityAccountTotal, currentYearEarnings])
    const liabilitiesAndEquity = addDecimal([liabilityTotal, equityTotal])
    const difference = subtractDecimal(assetTotal, liabilitiesAndEquity)

    return {
      asOfDate,
      sections: {
        assets: { accounts: assets, total: assetTotal },
        liabilities: { accounts: liabilities, total: liabilityTotal },
        equity: { accounts: equity, accountTotal: equityAccountTotal, currentYearEarnings, total: equityTotal },
      },
      assets: assetTotal,
      liabilities: liabilityTotal,
      equity: equityTotal,
      liabilitiesAndEquity,
      difference,
      balanced: compareDecimal(difference, '0') === 0,
    }
  }

  async cashFlow(companyId: number, range: DateRange) {
    const result = await this.repository.cashFlow(companyId, range)
    const amounts = new Map(
      (result.activities as ReportRow[]).map((row) => [String(row.activity), money(row.amount)]),
    )
    const operating = amounts.get('operating') ?? '0.00'
    const investing = amounts.get('investing') ?? '0.00'
    const financing = amounts.get('financing') ?? '0.00'
    const netChange = addDecimal([operating, investing, financing])
    const openingBalance = money(result.balances.opening_balance)
    const endingBalance = money(result.balances.ending_balance)
    const expectedEnding = addDecimal([openingBalance, netChange])

    return {
      range,
      method: 'cash-account-classification',
      activities: { operating, investing, financing },
      openingBalance,
      netChange,
      endingBalance,
      difference: subtractDecimal(endingBalance, expectedEnding),
      reconciled: compareDecimal(endingBalance, expectedEnding) === 0,
    }
  }

  async aging(companyId: number, side: 'receivable' | 'payable', asOfDate: string) {
    const rows = (await this.repository.aging(companyId, side, asOfDate)) as ReportRow[]
    const buckets = { current: 0n, '1-30': 0n, '31-60': 0n, '61-90': 0n, '>90': 0n }
    for (const row of rows) {
      const bucket = String(row.aging_bucket) as keyof typeof buckets
      buckets[bucket] += toScaledInteger(money(row.outstanding_amount))
    }
    return {
      asOfDate,
      rows,
      buckets: Object.fromEntries(
        Object.entries(buckets).map(([bucket, value]) => [bucket, fromScaledInteger(value)]),
      ),
      total: fromScaledInteger(Object.values(buckets).reduce((sum, value) => sum + value, 0n)),
    }
  }

  inventory(companyId: number, asOfDate?: string) {
    return this.repository.inventoryValuation(companyId, asOfDate)
  }

  async subledger(companyId: number, asOfDate: string) {
    const rows = (await this.repository.subledgerReconciliation(companyId, asOfDate)) as ReportRow[]
    return rows.map((row) => {
      const subledger = money(row.subledger)
      const generalLedger = money(row.general_ledger)
      const difference = subtractDecimal(subledger, generalLedger)
      return {
        type: String(row.reconciliation_type),
        subledger,
        generalLedger,
        difference,
        balanced: compareDecimal(difference, '0') === 0,
      }
    })
  }

  async budgetVsActual(
    companyId: number,
    filters: DateRange & { accountId?: number; costCenterId?: number; projectId?: number },
  ) {
    const rows = (await this.repository.budgetVsActual(companyId, filters)) as ReportRow[]
    return rows.map((row) => {
      const budget = money(row.budget)
      const rawActual = money(row.actual)
      const actual = ['revenue', 'other_income'].includes(String(row.account_type))
        ? fromScaledInteger(-toScaledInteger(rawActual))
        : rawActual
      const variance = subtractDecimal(budget, actual)
      const budgetMinor = toScaledInteger(budget)
      const variancePercent =
        budgetMinor === 0n
          ? null
          : Number((toScaledInteger(variance) * 10_000n) / budgetMinor) / 100
      return { ...row, budget, actual, variance, variancePercent }
    })
  }
}
