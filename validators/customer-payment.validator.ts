// src/validators/customer-payment.validator.ts
import { z } from 'zod'

export const CustomerPaymentInput = z.object({
  payment_date: z
    .string()
    .refine((d) => !isNaN(Date.parse(d)), { message: 'Tanggal pembayaran tidak valid' }),
  customer_id: z.number().int().positive(),
  bank_account_id: z.number().int().positive().nullable().optional(),
  cash_account_id: z.number().int().positive(),
  payment_method: z.enum(['cash', 'bank_transfer', 'check', 'card', 'other']),
  reference: z.string().trim().max(100).nullable().optional(),
  amount: z.string().regex(/^\d+(\.\d{1,4})?$/, { message: 'Jumlah harus berupa angka desimal' }),
  currency: z.string().length(3),
  exchange_rate: z.string().regex(/^\d+(\.\d{1,8})?$/, { message: 'Kurs harus berupa angka' }),
  notes: z.string().optional().nullable(),
  allocations: z
    .array(
      z.object({
        invoice_id: z.number().int().positive(),
        amount: z.string().regex(/^\d+(\.\d{1,4})?$/),
      }),
    )
    .optional(),
})

export type CustomerPaymentInput = z.infer<typeof CustomerPaymentInput>
