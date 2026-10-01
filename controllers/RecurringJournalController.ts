import type { Context } from 'hono'
import { RecurringJournalService } from '../services/RecurringJournalService'
import type { PostingContext } from '../services/PostingService'
import { created, ok } from '../utils/response'
import {
  recurringGenerateSchema,
  recurringActiveSchema,
  recurringIdSchema,
  recurringJournalSchema,
  recurringJournalUpdateSchema,
} from '../validators/recurring-journal.validator'

export class RecurringJournalController {
  constructor(private service = new RecurringJournalService()) {}

  overview = async (c: Context) => ok(c, await this.service.overview(c.get('user').companyId))

  create = async (c: Context) =>
    created(
      c,
      await this.service.create(
        c.get('user').companyId,
        recurringJournalSchema.parse(await c.req.json()),
        this.context(c),
      ),
      'Jadwal jurnal berhasil dibuat',
    )

  update = async (c: Context) =>
    ok(
      c,
      await this.service.update(
        c.get('user').companyId,
        recurringIdSchema.parse(c.req.param('id')),
        recurringJournalUpdateSchema.parse(await c.req.json()),
        this.context(c),
      ),
      'Jadwal jurnal berhasil diperbarui',
    )

  setActive = async (c: Context) => {
    const body = recurringActiveSchema.parse(await c.req.json())
    return ok(
      c,
      await this.service.setActive(
        c.get('user').companyId,
        recurringIdSchema.parse(c.req.param('id')),
        body.active,
        this.context(c),
      ),
      body.active ? 'Jadwal diaktifkan' : 'Jadwal dinonaktifkan',
    )
  }

  generate = async (c: Context) => {
    const input = recurringGenerateSchema.parse(await c.req.json())
    return created(
      c,
      await this.service.generate(
        c.get('user').companyId,
        recurringIdSchema.parse(c.req.param('id')),
        input.as_of_date,
        this.context(c),
      ),
      'Jurnal berhasil dibuat dari jadwal',
    )
  }

  generateDue = async (c: Context) => {
    const input = recurringGenerateSchema.parse(await c.req.json())
    return ok(
      c,
      await this.service.generateDue(c.get('user').companyId, input.as_of_date, this.context(c)),
      'Jurnal jatuh tempo selesai diproses',
    )
  }

  private context(c: Context): PostingContext {
    return {
      userId: c.get('user').id,
      requestId: c.get('requestId'),
      ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    }
  }
}
