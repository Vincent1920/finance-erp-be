import type { Context } from 'hono'
import { z } from 'zod'
import { MonthEndService } from '../services/MonthEndService'
import { ok } from '../utils/response'

const querySchema = z.object({ as_of_date: z.iso.date() })

export class MonthEndController {
  constructor(private service = new MonthEndService()) {}
  dashboard = async (c: Context) => {
    const query = querySchema.parse(c.req.query())
    return ok(c, await this.service.dashboard(c.get('user').companyId, query.as_of_date))
  }
  export = async (c: Context) => {
    const query = querySchema.parse(c.req.query())
    const content = await this.service.exportPackage(c.get('user').companyId, query.as_of_date)
    return c.body(
      content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength,
      ) as ArrayBuffer,
      200,
      {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="paket-tutup-bulan-${query.as_of_date.slice(0, 7)}.xlsx"`,
      },
    )
  }
}
