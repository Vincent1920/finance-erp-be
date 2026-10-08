import type { Context } from 'hono'
import { AccountingScheduleService } from '../services/AccountingScheduleService'
import type { PostingContext } from '../services/PostingService'
import { created, ok } from '../utils/response'
import { ValidationError } from '../utils/AppError'
import {
  accountingScheduleIdSchema,
  accountingScheduleSchema,
  scheduleGenerateSchema,
  scheduleReconcileSchema,
  scheduleAdjustmentSchema,
} from '../validators/accounting-schedule.validator'

export class AccountingScheduleController {
  constructor(private service = new AccountingScheduleService()) {}
  overview = async (c: Context) => ok(c, await this.service.overview(c.get('user').companyId))
  actualSources = async (c: Context) =>
    ok(
      c,
      await this.service.actualSources(
        c.get('user').companyId,
        accountingScheduleIdSchema.parse(c.req.param('id')),
      ),
    )
  adjustment = async (c: Context) =>
    created(
      c,
      await this.service.adjustment(
        c.get('user').companyId,
        accountingScheduleIdSchema.parse(c.req.param('id')),
        scheduleAdjustmentSchema.parse(await c.req.json()),
        this.context(c),
      ),
    )
  templates = async (c: Context) => ok(c, await this.service.templates(c.get('user').companyId))
  alerts = async (c: Context) => {
    const input = scheduleGenerateSchema.parse(c.req.query())
    return ok(c, await this.service.alerts(c.get('user').companyId, input.as_of_date))
  }
  create = async (c: Context) =>
    created(
      c,
      await this.service.create(
        c.get('user').companyId,
        accountingScheduleSchema.parse(await c.req.json()),
        this.context(c),
      ),
      'Jadwal berhasil dibuat',
    )
  generateDue = async (c: Context) => {
    const input = scheduleGenerateSchema.parse(await c.req.json())
    return ok(
      c,
      await this.service.generateDue(c.get('user').companyId, input.as_of_date, this.context(c)),
      'Jadwal jatuh tempo selesai diproses',
    )
  }
  processReversals = async (c: Context) => {
    const input = scheduleGenerateSchema.parse(await c.req.json())
    return ok(
      c,
      await this.service.processReversals(
        c.get('user').companyId,
        input.as_of_date,
        this.context(c),
      ),
      'Pembalikan otomatis selesai diproses',
    )
  }
  generate = async (c: Context) =>
    created(
      c,
      await this.service.generate(
        c.get('user').companyId,
        accountingScheduleIdSchema.parse(c.req.param('id')),
        this.context(c),
      ),
      'Jurnal berhasil dibuat',
    )
  reverse = async (c: Context) =>
    created(
      c,
      await this.service.reverse(
        c.get('user').companyId,
        accountingScheduleIdSchema.parse(c.req.param('id')),
        this.context(c),
      ),
      'Jurnal pembalikan berhasil dibuat',
    )
  reconcile = async (c: Context) =>
    ok(
      c,
      await this.service.reconcile(
        c.get('user').companyId,
        accountingScheduleIdSchema.parse(c.req.param('id')),
        scheduleReconcileSchema.parse(await c.req.json()),
        this.context(c),
      ),
      'Nilai aktual berhasil dicatat',
    )
  uploadAttachment = async (c: Context) => {
    const body = await c.req.parseBody()
    if (!(body.file instanceof File)) throw new ValidationError('File lampiran wajib dipilih')
    return created(
      c,
      await this.service.uploadAttachment(
        c.get('user').companyId,
        accountingScheduleIdSchema.parse(c.req.param('id')),
        body.file,
        this.context(c),
      ),
      'Lampiran berhasil diunggah',
    )
  }
  downloadAttachment = async (c: Context) => {
    const attachment = await this.service.attachment(
      c.get('user').companyId,
      accountingScheduleIdSchema.parse(c.req.param('id')),
    )
    const name = String(attachment.original_name).replace(/[^A-Za-z0-9._ -]/g, '_')
    return c.body(await Bun.file(String(attachment.path)).arrayBuffer(), 200, {
      'Content-Type': String(attachment.mime_type),
      'Content-Disposition': `attachment; filename="${name}"`,
    })
  }
  removeAttachment = async (c: Context) =>
    ok(
      c,
      await this.service.removeAttachment(
        c.get('user').companyId,
        accountingScheduleIdSchema.parse(c.req.param('id')),
        this.context(c),
      ),
      'Lampiran dihapus',
    )
  private context(c: Context): PostingContext {
    return {
      userId: c.get('user').id,
      requestId: c.get('requestId'),
      ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    }
  }
}
