import type { Context } from 'hono'

import { transaction } from '../config/database'
import { JournalRepository } from '../repositories/JournalRepository'
import { PostingService, assertBalanced } from '../services/PostingService'
import { created, ok } from '../utils/response'
import { journalSchema } from '../validators/journal.validator'

export class JournalController {
  constructor(
    private repo = new JournalRepository(),
    private posting = new PostingService(),
  ) {}

  create = async (c: Context) => {
    const input = journalSchema.parse(await c.req.json())
    const user = c.get('user')

    assertBalanced(input.lines)

    const id = await transaction((connection) =>
      this.repo.create(connection, {
        companyId: user.companyId,
        number: input.journal_number,
        date: input.journal_date,
        reference: input.reference,
        description: input.description,
        userId: user.id,
        lines: input.lines,
      }),
    )

    return created(c, { id }, 'Jurnal berhasil dibuat')
  }

  post = async (c: Context) => {
    const journalId = Number(c.req.param('id'))
    const user = c.get('user')
    const journal = await this.posting.postManual(journalId, user.companyId, user.id)

    return ok(c, journal, 'Jurnal berhasil diposting')
  }
}
