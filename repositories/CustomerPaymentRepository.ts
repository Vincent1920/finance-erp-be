import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'

import { db } from '../config/database'
import type { DatabaseValue, QueryExecutor } from '../types/database'
import { NotFoundError } from '../utils/AppError'

export interface CustomerPaymentRow extends RowDataPacket {
  id: number
  company_id: number
  payment_number: string
  payment_date: Date | string
  customer_id: number
  bank_account_id: number | null
  cash_account_id: number
  payment_method: string
  currency: string
  exchange_rate: string | number
  amount: string | number
  base_amount: string | number
  unallocated_amount: string | number
  status: string
  journal_id: number | null
  reversal_journal_id: number | null
  submitted_by: number | null
  version: number
}

export interface CustomerPaymentAllocationWrite {
  invoiceId: number
  amount: string
  baseAmount: string
}

export interface CustomerPaymentWrite {
  companyId: number
  number: string
  paymentDate: string
  customerId: number
  bankAccountId?: number | null
  cashAccountId: number
  paymentMethod: string
  reference?: string | null
  amount: string
  baseAmount: string
  unallocatedAmount: string
  currency: string
  exchangeRate: string
  notes?: string | null
  userId: number
}

export class CustomerPaymentRepository {
  async list(companyId: number, query: { offset: number; limit: number }) {
    const [rows] = await db.execute<CustomerPaymentRow[]>(
      `SELECT cp.*, c.code AS customer_code, c.name AS customer_name,
              ba.code AS bank_account_code, a.code AS cash_account_code
       FROM customer_payments cp
       INNER JOIN customers c ON c.id = cp.customer_id AND c.company_id = cp.company_id
       LEFT JOIN bank_accounts ba ON ba.id = cp.bank_account_id AND ba.company_id = cp.company_id
       INNER JOIN accounts a ON a.id = cp.cash_account_id AND a.company_id = cp.company_id
       WHERE cp.company_id = ?
       ORDER BY cp.payment_date DESC, cp.id DESC
       LIMIT ? OFFSET ?`,
      [companyId, query.limit, query.offset],
    )
    return rows
  }

  async detail(id: number, companyId: number) {
    const payment = await this.find(db, id, companyId)
    if (!payment) throw new NotFoundError('Penerimaan piutang tidak ditemukan')
    const [allocations] = await db.execute<RowDataPacket[]>(
      `SELECT a.*, i.invoice_number, i.invoice_date, i.due_date, i.grand_total,
              i.outstanding_amount
       FROM customer_payment_allocations a
       INNER JOIN sales_invoices i ON i.id = a.sales_invoice_id
       WHERE a.customer_payment_id = ? AND i.company_id = ?
       ORDER BY a.id`,
      [id, companyId],
    )
    return { ...payment, allocations }
  }

  async insert(
    connection: QueryExecutor,
    data: CustomerPaymentWrite,
    allocations: CustomerPaymentAllocationWrite[],
  ): Promise<number> {
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO customer_payments (
         company_id, payment_number, payment_date, customer_id, bank_account_id,
         cash_account_id, payment_method, reference, amount, base_amount,
         bank_amount, base_bank_amount, unallocated_amount, currency, exchange_rate, notes, created_by, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
      [
        data.companyId,
        data.number,
        data.paymentDate,
        data.customerId,
        data.bankAccountId ?? null,
        data.cashAccountId,
        data.paymentMethod,
        data.reference ?? null,
        data.amount,
        data.baseAmount,
        data.amount,
        data.baseAmount,
        data.unallocatedAmount,
        data.currency,
        data.exchangeRate,
        data.notes ?? null,
        data.userId,
      ],
    )
    for (const allocation of allocations) {
      await connection.execute<ResultSetHeader>(
        `INSERT INTO customer_payment_allocations (
           customer_payment_id, sales_invoice_id, amount, base_amount
         ) VALUES (?, ?, ?, ?)`,
        [result.insertId, allocation.invoiceId, allocation.amount, allocation.baseAmount],
      )
    }
    return result.insertId
  }

  async transition(
    connection: QueryExecutor,
    id: number,
    companyId: number,
    fromStatuses: string[],
    setClause: string,
    values: DatabaseValue[],
  ): Promise<boolean> {
    const marks = fromStatuses.map(() => '?').join(',')
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE customer_payments
       SET ${setClause}, version = version + 1
       WHERE id = ? AND company_id = ? AND status IN (${marks})`,
      [...values, id, companyId, ...fromStatuses],
    )
    return result.affectedRows > 0
  }

  async find(connection: QueryExecutor, id: number, companyId: number, lock = false) {
    const [rows] = await connection.execute<CustomerPaymentRow[]>(
      `SELECT * FROM customer_payments
       WHERE id = ? AND company_id = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
      [id, companyId],
    )
    return rows[0] ?? null
  }

  async setting(connection: QueryExecutor, companyId: number, key: string) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT setting_value FROM settings
       WHERE company_id = ? AND setting_key = ? LIMIT 1`,
      [companyId, key],
    )
    return Number(String(rows[0]?.setting_value ?? '').replaceAll('"', '')) || null
  }
}
