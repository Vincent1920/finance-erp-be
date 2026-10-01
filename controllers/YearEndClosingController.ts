import type { Context } from 'hono'
import { YearEndClosingService } from '../services/YearEndClosingService'
import { positiveIdSchema } from '../validators/common.validator'
import { yearEndPreviewSchema, yearEndReverseSchema } from '../validators/year-end.validator'
import { ok } from '../utils/response'
import { requestIp } from '../utils/request-context'

const context = (c: Context) => ({
  userId: c.get('user').id,
  requestId: c.get('requestId'),
  ip: requestIp(c),
})

export class YearEndClosingController {
  constructor(private service = new YearEndClosingService()) {}
  overview = async (c: Context) => ok(c, await this.service.overview(c.get('user').companyId))
  preview = async (c: Context) =>
    ok(
      c,
      await this.service.preview(
        c.get('user').companyId,
        yearEndPreviewSchema.parse(await c.req.json()),
      ),
    )
  validate = async (c: Context) =>
    ok(
      c,
      await this.service.validate(
        c.get('user').companyId,
        yearEndPreviewSchema.parse(await c.req.json()),
        context(c),
      ),
      'Penutupan tahun berhasil divalidasi',
    )
  post = async (c: Context) =>
    ok(
      c,
      await this.service.post(
        c.get('user').companyId,
        positiveIdSchema.parse(c.req.param('id')),
        context(c),
      ),
      'Jurnal tutup tahun berhasil diposting',
    )
  reverse = async (c: Context) => {
    const input = yearEndReverseSchema.parse(await c.req.json())
    return ok(
      c,
      await this.service.reverse(
        c.get('user').companyId,
        positiveIdSchema.parse(c.req.param('id')),
        input.reversal_date,
        input.reason,
        context(c),
      ),
      'Penutupan tahun berhasil dibalik',
    )
  }
}
