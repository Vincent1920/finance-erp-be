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

export const sequenceDefinitions = {
  equity_transaction: { label: 'Transaksi Modal & Ekuitas', category: 'Akuntansi', prefix: 'EQ-{YYYY}-{MM}-', storage: ['equity_transactions', 'transaction_number'] },
  sales_order: { label: 'Sales Order', category: 'Penjualan', prefix: 'SO-{YYYY}-{MM}-', storage: ['sales_orders', 'order_number'] },
  sales_invoice: { label: 'Invoice Penjualan', category: 'Penjualan', prefix: 'SI-{YYYY}-{MM}-', storage: ['sales_invoices', 'invoice_number'] },
  sales_return: { label: 'Retur Penjualan', category: 'Penjualan', prefix: 'SR-{YYYY}-{MM}-', storage: ['sales_returns', 'return_number'] },
  customer_payment: { label: 'Pelunasan Piutang', category: 'Penjualan', prefix: 'CR-{YYYY}-{MM}-', storage: ['customer_payments', 'payment_number'] },
  customer_credit: { label: 'Kredit Pelanggan', category: 'Penjualan', prefix: 'CC-{YYYY}-{MM}-', storage: ['party_credits', 'credit_number'] },
  customer_refund: { label: 'Refund Pelanggan', category: 'Penjualan', prefix: 'RC-{YYYY}-{MM}-' },
  purchase_order: { label: 'Purchase Order', category: 'Pembelian', prefix: 'PO-{YYYY}-{MM}-', storage: ['purchase_orders', 'order_number'] },
  goods_receipt: { label: 'Penerimaan Barang', category: 'Pembelian', prefix: 'GR-{YYYY}-{MM}-', storage: ['goods_receipts', 'receipt_number'] },
  purchase_invoice: { label: 'Invoice Pembelian', category: 'Pembelian', prefix: 'PI-{YYYY}-{MM}-', storage: ['purchase_invoices', 'invoice_number'] },
  purchase_return: { label: 'Retur Pembelian', category: 'Pembelian', prefix: 'PR-{YYYY}-{MM}-', storage: ['purchase_returns', 'return_number'] },
  supplier_payment: { label: 'Pelunasan Utang', category: 'Pembelian', prefix: 'CP-{YYYY}-{MM}-', storage: ['supplier_payments', 'payment_number'] },
  supplier_credit: { label: 'Kredit Pemasok', category: 'Pembelian', prefix: 'SC-{YYYY}-{MM}-', storage: ['party_credits', 'credit_number'] },
  supplier_refund: { label: 'Refund Pemasok', category: 'Pembelian', prefix: 'RS-{YYYY}-{MM}-' },
  journal: { label: 'Jurnal', category: 'Akuntansi', prefix: 'JV-{YYYY}-{MM}-', storage: ['journals', 'journal_number'] },
  recurring_journal: { label: 'Jurnal Berulang', category: 'Akuntansi', prefix: 'RJ-{YYYY}-{MM}-', storage: ['recurring_journals', 'template_number'] },
  accounting_schedule: { label: 'Jadwal Akrual / Prepaid', category: 'Akuntansi', prefix: 'AS-{YYYY}-{MM}-', storage: ['accounting_schedules', 'schedule_number'] },
  stock_transfer: { label: 'Transfer Stok', category: 'Persediaan', prefix: 'ST-{YYYY}-{MM}-', storage: ['stock_transfers', 'transfer_number'] },
  stock_adjustment: { label: 'Penyesuaian Stok', category: 'Persediaan', prefix: 'SA-{YYYY}-{MM}-', storage: ['stock_adjustments', 'adjustment_number'] },
  backup: { label: 'Backup', category: 'Sistem', prefix: 'BKP-{YYYY}-{MM}-', storage: ['backup_jobs', 'backup_number'] },
} as const

export type SequenceKey = keyof typeof sequenceDefinitions

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
    day: String(date.getUTCDate()).padStart(2, '0'),
  }
}

export function ensureMonthlyPrefix(prefix: string) {
  if (prefix.includes('{MM}')) return prefix
  if (prefix.includes('{YYYY}')) return prefix.replace('{YYYY}', '{YYYY}-{MM}')
  if (prefix.includes('{YY}')) return prefix.replace('{YY}', '{YY}-{MM}')
  return `${prefix.replace(/[-/_.]+$/, '')}-{YYYY}-{MM}-`
}

export function renderSequencePrefix(prefix: string, date: Date | string = new Date()) {
  const { year, month, day } = dateParts(date)
  return ensureMonthlyPrefix(prefix)
    .replaceAll('{YYYY}', year)
    .replaceAll('{YY}', year.slice(-2))
    .replaceAll('{MM}', month)
    .replaceAll('{DD}', day)
}

export function sequencePreview(prefix: string, padding: number, nextNumber: number, date: Date | string = new Date()) {
  return `${renderSequencePrefix(prefix, date)}${String(nextNumber).padStart(padding, '0')}`
}

export class NumberSequenceService {
  async next(connection: QueryExecutor, companyId: number, sequenceKey: string, date: Date | string = new Date()): Promise<string> {
    const definition = sequenceDefinitions[sequenceKey as SequenceKey]
    if (definition) {
      await connection.execute<ResultSetHeader>(
        `INSERT INTO number_sequences (
           company_id, sequence_key, prefix, current_number, padding, reset_period, last_reset_key
         ) VALUES (?, ?, ?, 0, 6, 'monthly', NULL)
         ON DUPLICATE KEY UPDATE sequence_key = VALUES(sequence_key)`,
        [companyId, sequenceKey, definition.prefix],
      )
    }

    const [rows] = await connection.execute<SequenceRow[]>(
      `SELECT id, prefix, current_number, padding, reset_period, last_reset_key
       FROM number_sequences WHERE company_id = ? AND sequence_key = ? FOR UPDATE`,
      [companyId, sequenceKey],
    )
    const sequence = rows[0]
    if (!sequence) throw new NotFoundError(`Sequence ${sequenceKey} belum dikonfigurasi`)

    const { year, month } = dateParts(date)
    const resetKey = sequence.reset_period === 'monthly' ? `${year}-${month}` : sequence.reset_period === 'yearly' ? year : 'never'
    let nextNumber = sequence.last_reset_key === resetKey ? sequence.current_number + 1 : 1
    const storage = definition && 'storage' in definition ? definition.storage : undefined
    if (storage) {
      const [table, column] = storage
      while (true) {
        const candidate = sequencePreview(sequence.prefix, sequence.padding, nextNumber, date)
        const [existing] = await connection.execute<RowDataPacket[]>(
          `SELECT id FROM ${table} WHERE company_id = ? AND ${column} = ? LIMIT 1`,
          [companyId, candidate],
        )
        if (!existing[0]) break
        nextNumber += 1
      }
    }
    await connection.execute(`UPDATE number_sequences SET current_number = ?, last_reset_key = ? WHERE id = ?`, [nextNumber, resetKey, sequence.id])
    return sequencePreview(sequence.prefix, sequence.padding, nextNumber, date)
  }
}
