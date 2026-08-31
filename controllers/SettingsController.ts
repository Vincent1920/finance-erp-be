import type { Context } from 'hono'
import { SettingsService } from '../services/SettingsService'
import { ok } from '../utils/response'
import { systemActor } from '../utils/request-context'
import {
  companyProfileSchema,
  sequenceSchema,
  settingEntrySchema,
  settingsBulkSchema,
} from '../validators/system.validator'

export class SettingsController {
  constructor(private readonly service = new SettingsService()) {}

  list = async (c: Context) =>
    ok(c, await this.service.list(c.get('user').companyId, c.req.query('category')))

  get = async (c: Context) => {
    const key = c.req.param('key')

    if (!key) {
      return c.json({ success: false, message: 'Key pengaturan wajib diisi' }, 400)
    }

    return ok(c, await this.service.get(c.get('user').companyId, key))
  }

  updateMany = async (c: Context) => {
    const { settings } = settingsBulkSchema.parse(await c.req.json())
    return ok(c, await this.service.updateMany(systemActor(c), settings), 'Pengaturan diperbarui')
  }

  update = async (c: Context) => {
    const input = settingEntrySchema.parse({ ...(await c.req.json()), key: c.req.param('key') })
    const rows = await this.service.updateMany(systemActor(c), [input])
    return ok(c, rows[0], 'Pengaturan diperbarui')
  }

  company = async (c: Context) => ok(c, await this.service.company(c.get('user').companyId))

  updateCompany = async (c: Context) =>
    ok(
      c,
      await this.service.updateCompany(
        systemActor(c),
        companyProfileSchema.parse(await c.req.json()),
      ),
      'Profil perusahaan diperbarui',
    )

  sequences = async (c: Context) => ok(c, await this.service.sequences(c.get('user').companyId))

  updateSequence = async (c: Context) =>
    ok(
      c,
      await this.service.upsertSequence(
        systemActor(c),
        sequenceSchema.parse({
          ...(await c.req.json()),
          sequence_key: c.req.param('sequenceKey'),
        }),
      ),
      'Format nomor dokumen diperbarui',
    )
}
