import type { Context } from 'hono'
import { PeriodClosingService } from '../services/PeriodClosingService'
import { positiveIdSchema } from '../validators/common.validator'
import {
  periodCloseQuerySchema,
  periodCloseValidationSchema,
  periodReopenSchema,
} from '../validators/period-closing.validator'
import { ok } from '../utils/response'
import { requestIp } from '../utils/request-context'

const context = (c: Context) => ({
  userId: c.get('user').id,
  requestId: c.get('requestId'),
  ip: requestIp(c),
})

export class PeriodClosingController {
  constructor(private service = new PeriodClosingService()) {}

  overview = async (c: Context) => {
    const query = periodCloseQuerySchema.parse(c.req.query())
    return ok(c, await this.service.overview(c.get('user').companyId, query.year))
  }

  validate = async (c: Context) =>
    ok(
      c,
      await this.service.validate(
        c.get('user').companyId,
        periodCloseValidationSchema.parse(await c.req.json()),
        context(c),
      ),
      'Pemeriksaan penutupan selesai',
    )

  complete = async (c: Context) =>
    ok(
      c,
      await this.service.complete(
        c.get('user').companyId,
        positiveIdSchema.parse(c.req.param('id')),
        context(c),
      ),
      'Periode berhasil ditutup',
    )

  reopen = async (c: Context) =>
    ok(
      c,
      await this.service.reopen(
        c.get('user').companyId,
        positiveIdSchema.parse(c.req.param('id')),
        periodReopenSchema.parse(await c.req.json()).reason,
        context(c),
      ),
      'Periode berhasil dibuka kembali',
    )
}
