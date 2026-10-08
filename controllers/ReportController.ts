import type { Context } from 'hono'
import { AccountingControlService } from '../services/AccountingControlService'

import { ReportingService } from '../services/ReportingService'
import { ok, paginated } from '../utils/response'
import {
  asOfQuerySchema,
  budgetActualQuerySchema,
  dateRangeQuerySchema,
  generalLedgerQuerySchema,
  inventoryReportQuerySchema,
  reconciliationCaseSchema,
  reconciliationDetailQuerySchema,
} from '../validators/report.validator'
import { ReconciliationWorkspaceService } from '../services/ReconciliationWorkspaceService'
import { requestIp } from '../utils/request-context'

export class ReportController {
  controls = async (c: Context) => {
    const query = asOfQuerySchema.parse(c.req.query())
    return ok(c, await new AccountingControlService().overview(c.get('user').companyId, query.as_of_date))
  }
  constructor(
    private service = new ReportingService(),
    private reconciliation = new ReconciliationWorkspaceService(),
  ) {}

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

  reconciliationDetail = async (c: Context) => {
    const query = reconciliationDetailQuerySchema.parse(c.req.query())
    return ok(c, await this.reconciliation.detail(
      c.get('user').companyId, query.reconciliation_type, query.account_id, query.as_of_date,
    ))
  }

  reconciliationCase = async (c: Context) => {
    const input = reconciliationCaseSchema.parse(await c.req.json())
    const user = c.get('user')
    return ok(c, await this.reconciliation.saveCase(user.companyId, input, {
      userId: user.id, requestId: c.get('requestId'), ip: requestIp(c),
    }), 'Tindak lanjut rekonsiliasi berhasil disimpan')
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
