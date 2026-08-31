import type { Context } from 'hono'

import { ReportingService } from '../services/ReportingService'
import { ok, paginated } from '../utils/response'
import {
  asOfQuerySchema,
  budgetActualQuerySchema,
  dateRangeQuerySchema,
  generalLedgerQuerySchema,
  inventoryReportQuerySchema,
} from '../validators/report.validator'

export class ReportController {
  constructor(private service = new ReportingService()) {}

  generalLedger = async (c: Context) => {
    const query = generalLedgerQuerySchema.parse(c.req.query())
    const result = await this.service.generalLedger(c.get('user').companyId, {
      dateFrom: query.date_from,
      dateTo: query.date_to,
      accountId: query.account_id,
      costCenterId: query.cost_center_id,
      projectId: query.project_id,
      reference: query.reference,
      page: query.page,
      limit: query.limit,
    })
    return paginated(c, result.rows, result)
  }

  trialBalance = async (c: Context) => {
    const query = dateRangeQuerySchema.parse(c.req.query())
    return ok(
      c,
      await this.service.trialBalance(c.get('user').companyId, {
        dateFrom: query.date_from,
        dateTo: query.date_to,
      }),
    )
  }

  profitLoss = async (c: Context) => {
    const query = dateRangeQuerySchema.parse(c.req.query())
    return ok(
      c,
      await this.service.profitLoss(c.get('user').companyId, {
        dateFrom: query.date_from,
        dateTo: query.date_to,
      }),
    )
  }

  balanceSheet = async (c: Context) => {
    const query = asOfQuerySchema.parse(c.req.query())
    return ok(c, await this.service.balanceSheet(c.get('user').companyId, query.as_of_date))
  }

  cashFlow = async (c: Context) => {
    const query = dateRangeQuerySchema.parse(c.req.query())
    return ok(
      c,
      await this.service.cashFlow(c.get('user').companyId, {
        dateFrom: query.date_from,
        dateTo: query.date_to,
      }),
    )
  }

  receivableAging = async (c: Context) => {
    const query = asOfQuerySchema.parse(c.req.query())
    return ok(
      c,
      await this.service.aging(c.get('user').companyId, 'receivable', query.as_of_date),
    )
  }

  payableAging = async (c: Context) => {
    const query = asOfQuerySchema.parse(c.req.query())
    return ok(
      c,
      await this.service.aging(c.get('user').companyId, 'payable', query.as_of_date),
    )
  }

  inventory = async (c: Context) => {
    const query = inventoryReportQuerySchema.parse(c.req.query())
    return ok(
      c,
      await this.service.inventory(c.get('user').companyId, query.as_of_date),
    )
  }

  subledger = async (c: Context) => {
    const query = asOfQuerySchema.parse(c.req.query())
    return ok(c, await this.service.subledger(c.get('user').companyId, query.as_of_date))
  }

  budgetVsActual = async (c: Context) => {
    const query = budgetActualQuerySchema.parse(c.req.query())
    return ok(
      c,
      await this.service.budgetVsActual(c.get('user').companyId, {
        dateFrom: query.date_from,
        dateTo: query.date_to,
        accountId: query.account_id,
        costCenterId: query.cost_center_id,
        projectId: query.project_id,
      }),
    )
  }
}
