import { transaction } from '../config/database'
import { JOURNAL_STATUS, MONEY_TOLERANCE, PERIOD_STATUS } from '../constants/accounting'
import { JournalRepository } from '../repositories/JournalRepository'
import { ConflictError, NotFoundError, ValidationError } from '../utils/AppError'

export interface JournalLineInput {
  accountId: number
  description?: string
  debit: number
  credit: number
}
export function assertBalanced(lines: JournalLineInput[]) {
  const totalDebit = lines.reduce((sum, line) => sum + Number(line.debit), 0)
  const totalCredit = lines.reduce((sum, line) => sum + Number(line.credit), 0)
  const difference = totalDebit - totalCredit

  if (lines.length < 2 || Math.abs(difference) > MONEY_TOLERANCE) {
    throw new ValidationError('Jurnal tidak balance', {
      debit: totalDebit,
      credit: totalCredit,
      difference,
    })
  }

  if (totalDebit <= 0) {
    throw new ValidationError('Nilai jurnal harus lebih dari nol')
  }
}

export class PostingService {
  constructor(private journals = new JournalRepository()) {}

  async postManual(id: number, companyId: number, userId: number) {
    return transaction(async (connection) => {
      const journal = await this.journals.findForUpdate(connection, id, companyId)

      if (!journal) {
        throw new NotFoundError('Jurnal tidak ditemukan')
      }

      // The row lock and status guard make posting idempotent under concurrent requests.
      if (journal.status === JOURNAL_STATUS.POSTED) {
        throw new ConflictError('Jurnal sudah pernah diposting')
      }

      const isPostable =
        journal.status === JOURNAL_STATUS.APPROVED || journal.status === JOURNAL_STATUS.DRAFT

      if (!isPostable) {
        throw new ConflictError(`Status ${journal.status} tidak dapat diposting`)
      }

      const period = await this.journals.period(connection, companyId, String(journal.journal_date))

      if (!period || period.status === PERIOD_STATUS.CLOSED) {
        throw new ConflictError('Periode akuntansi sudah ditutup')
      }

      const lines = await this.journals.lines(connection, id)

      assertBalanced(
        lines.map((line) => ({
          accountId: Number(line.account_id),
          debit: Number(line.debit),
          credit: Number(line.credit),
        })),
      )

      await this.journals.markAsPosted(connection, id, userId)
      await this.journals.createPostingAuditLog(connection, id, companyId, userId)

      return { id, status: JOURNAL_STATUS.POSTED }
    })
  }
}
