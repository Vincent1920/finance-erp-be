// src/repositories/CustomerPaymentRepository.ts
import { transaction } from '../config/database';
import type { QueryExecutor } from '../types/database';
import { NotFoundError } from '../utils/AppError';

export class CustomerPaymentRepository {
  // List payments with pagination
  async list(companyId: number, query: { offset: number; limit: number }) {
    // Simple pagination query
    const rows = await transaction((q) =>
      q.execute('SELECT * FROM customer_payments WHERE company_id = ? ORDER BY payment_date DESC LIMIT ?, ?', [companyId, query.offset, query.limit]),
    );
    return rows;
  }

  // Fetch detail of a payment
  async detail(id: number, companyId: number) {
    const rows = await transaction((q) =>
      q.execute('SELECT * FROM customer_payments WHERE id = ? AND company_id = ?', [id, companyId]),
    );
    if (!rows[0]) throw new NotFoundError('Penerimaan piutang tidak ditemukan');
    return rows[0];
  }

  // Insert a new draft payment record
  async insert(
    q: QueryExecutor,
    data: {
      companyId: number;
      number: string;
      paymentDate: string;
      customerId: number;
      amount: string;
      currency: string;
      exchangeRate: string;
      notes?: string | null;
      userId: number;
    },
    allocations: Array<{ invoiceId: number; amount: string }>,
  ): Promise<number> {
    const result = await q.execute(
      `INSERT INTO customer_payments 
        (company_id, number, payment_date, customer_id, amount, currency, exchange_rate, notes, user_id, status) 
        VALUES (?,?,?,?,?,?,?,?,?, 'draft')`,
      [
        data.companyId,
        data.number,
        data.paymentDate,
        data.customerId,
        data.amount,
        data.currency,
        data.exchangeRate,
        data.notes ?? null,
        data.userId,
      ],
    );
    const paymentId = Number(result.lastInsertId);
    // Insert allocations if any
    for (const alloc of allocations) {
      await q.execute(
        `INSERT INTO customer_payment_allocations 
          (company_id, payment_id, invoice_id, amount) VALUES (?,?,?,?)`,
        [data.companyId, paymentId, alloc.invoiceId, alloc.amount],
      );
    }
    return paymentId;
  }

  // Transition status of a payment (used by service)
  async transition(
    q: QueryExecutor,
    id: number,
    companyId: number,
    fromStatuses: string[],
    setClause: string,
    values: any[],
  ): Promise<boolean> {
    const result = await q.execute(
      `UPDATE customer_payments SET ${setClause} WHERE id = ? AND company_id = ? AND status IN (${fromStatuses.map(() => '?').join(',')})`,
      [...values, id, companyId, ...fromStatuses],
    );
    return result.affectedRows > 0;
  }

  // Find payment for internal use (including draft flag)
  async find(q: QueryExecutor, id: number, companyId: number, lock: boolean = false) {
    const rows = await q.execute(
      `SELECT * FROM customer_payments WHERE id = ? AND company_id = ?${lock ? ' FOR UPDATE' : ''}`,
      [id, companyId],
    );
    return rows[0] ?? null;
  }
}
