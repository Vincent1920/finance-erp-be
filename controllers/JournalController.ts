import type { Context } from 'hono'

import { JournalService } from '../services/JournalService'
import type { PostingContext } from '../services/PostingService'
import { created, ok, paginated } from '../utils/response'
import {
  journalIdSchema,
  journalListQuerySchema,
  journalSchema,
  rejectionSchema,
  reversalSchema,
} from '../validators/journal.validator'

export class JournalController {
  constructor(private service = new JournalService()) {}

  list = async (c: Context) => {
    const query = journalListQuerySchema.parse(c.req.query())
    const result = await this.service.list(c.get('user').companyId, query)
    return paginated(c, result.rows, result)
  }

  get = async (c: Context) =>
    ok(c, await this.service.get(this.id(c), c.get('user').companyId))

  create = async (c: Context) => {
    const input = journalSchema.parse(await c.req.json())
    return created(
      c,
      await this.service.create(c.get('user').companyId, input, this.context(c)),
      'Jurnal berhasil dibuat',
    )
  }

  update = async (c: Context) => {
    const input = journalSchema.parse(await c.req.json())
    return ok(
      c,
      await this.service.update(this.id(c), c.get('user').companyId, input, this.context(c)),
      'Jurnal berhasil diperbarui',
    )
  }

  remove = async (c: Context) => {
    await this.service.remove(this.id(c), c.get('user').companyId, this.context(c))
    return ok(c, null, 'Jurnal draft berhasil dihapus')
  }

  submit = async (c: Context) =>
    ok(
      c,
      await this.service.submit(this.id(c), c.get('user').companyId, this.context(c)),
      'Jurnal diajukan untuk persetujuan',
    )

  approve = async (c: Context) =>
    ok(
      c,
      await this.service.approve(this.id(c), c.get('user').companyId, this.context(c)),
      'Jurnal disetujui',
    )

  reject = async (c: Context) => {
    const input = rejectionSchema.parse(await c.req.json())
    return ok(
      c,
      await this.service.reject(
        this.id(c),
        c.get('user').companyId,
        input.comments,
        this.context(c),
      ),
      'Jurnal ditolak',
    )
  }

  post = async (c: Context) =>
    ok(
      c,
      await this.service.post(this.id(c), c.get('user').companyId, this.context(c)),
      'Jurnal berhasil diposting',
    )

  reverse = async (c: Context) => {
    const input = reversalSchema.parse(await c.req.json())
    const reversalJournalId = await this.service.reverse(
      this.id(c),
      c.get('user').companyId,
      input.reversal_date,
      input.reason,
      this.context(c),
    )
    return created(c, { reversalJournalId }, 'Jurnal berhasil direversal')
  }

  private id(c: Context) {
    return journalIdSchema.parse(c.req.param('id'))
  }

  private context(c: Context): PostingContext {
    return {
      userId: c.get('user').id,
      requestId: c.get('requestId'),
      ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    }
  }
}
