import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import type { QueryExecutor } from '../types/database'
import { ConflictError, NotFoundError } from '../utils/AppError'

interface SequenceRow extends RowDataPacket {
  id: number
  prefix: string
  current_number: number
  padding: number
  reset_period: 'never' | 'yearly' | 'monthly'
  last_reset_key: string | null
}

const defaultSequences: Record<string, { prefix: string; padding: number }> = {
  sales_order: { prefix: 'SO-{YYYY}-', padding: 6 },
  sales_invoice: { prefix: 'SI-{YYYY}-', padding: 6 },
  sales_return: { prefix: 'SR-{YYYY}-', padding: 6 },
  customer_payment: { prefix: 'CR-{YYYY}-', padding: 6 },
  purchase_order: { prefix: 'PO-{YYYY}-', padding: 6 },
  purchase_invoice: { prefix: 'PI-{YYYY}-', padding: 6 },
  purchase_return: { prefix: 'PR-{YYYY}-', padding: 6 },
  supplier_payment: { prefix: 'CP-{YYYY}-', padding: 6 },
  journal: { prefix: 'JV-{YYYY}-', padding: 6 },
  stock_transfer: { prefix: 'ST-{YYYY}-', padding: 6 },
  stock_adjustment: { prefix: 'SA-{YYYY}-', padding: 6 },
  backup: { prefix: 'BKP-{YYYY}-', padding: 6 },
}

function normalizedDate(input: Date | string) {
  const date = input instanceof Date ? input : new Date(`${input}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) throw new ConflictError('Tanggal nomor dokumen tidak valid')
  return date
}

function dateParts(input: Date | string) {
  const date = normalizedDate(input)
  return {
    year: String(date.getUTCFullYear()),
    month: String(date.getUTCMonth() + 1).padStart(2, '0'),
  }
}

export class NumberSequenceService {
  async next(
    connection: QueryExecutor,
    companyId: number,
    sequenceKey: string,
    date: Date | string = new Date(),
  ): Promise<string> {
    const fallback = defaultSequences[sequenceKey]
    if (fallback) {
      await connection.execute<ResultSetHeader>(
        `INSERT INTO number_sequences (
           company_id, sequence_key, prefix, current_number, padding, reset_period, last_reset_key
         ) VALUES (?, ?, ?, 0, ?, 'yearly', NULL)
         ON DUPLICATE KEY UPDATE sequence_key = VALUES(sequence_key)`,
        [companyId, sequenceKey, fallback.prefix, fallback.padding],
      )
    }

    const [rows] = await connection.execute<SequenceRow[]>(
      `SELECT id, prefix, current_number, padding, reset_period, last_reset_key
       FROM number_sequences
       WHERE company_id = ? AND sequence_key = ?
       FOR UPDATE`,
      [companyId, sequenceKey],
    )
    const sequence = rows[0]
    if (!sequence) throw new NotFoundError(`Sequence ${sequenceKey} belum dikonfigurasi`)

    const { year, month } = dateParts(date)
    const resetKey =
      sequence.reset_period === 'monthly'
        ? `${year}-${month}`
        : sequence.reset_period === 'yearly'
          ? year
          : 'never'
    const nextNumber = sequence.last_reset_key === resetKey ? sequence.current_number + 1 : 1

    await connection.execute(
      `UPDATE number_sequences
       SET current_number = ?, last_reset_key = ?
       WHERE id = ?`,
      [nextNumber, resetKey, sequence.id],
    )

    const prefix = sequence.prefix
      .replaceAll('{YYYY}', year)
      .replaceAll('{YY}', year.slice(-2))
      .replaceAll('{MM}', month)
    return `${prefix}${String(nextNumber).padStart(sequence.padding, '0')}`
  }
}
