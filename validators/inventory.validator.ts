import { z } from 'zod'

import {
  isoDateSchema,
  listQuerySchema,
  positiveIdSchema,
  quantitySchema,
} from './common.validator'

export const stockOverviewQuerySchema = listQuerySchema.extend({
  warehouse_id: positiveIdSchema.optional(),
  item_id: positiveIdSchema.optional(),
  status: z.enum(['available', 'low_stock', 'out_of_stock']).optional(),
})

export const inventoryCardQuerySchema = z
  .object({
    item_id: positiveIdSchema,
    warehouse_id: positiveIdSchema.optional(),
    date_from: isoDateSchema,
    date_to: isoDateSchema,
    page: z.string().optional(),
    limit: z.string().optional(),
  })
  .refine((value) => value.date_from <= value.date_to, {
    message: 'date_from tidak boleh setelah date_to',
    path: ['date_to'],
  })

export const transferLineSchema = z.object({
  item_id: positiveIdSchema,
  description: z.string().trim().max(255).optional(),
  quantity: quantitySchema,
  unit_id: positiveIdSchema,
})

export const stockTransferSchema = z
  .object({
    transfer_date: isoDateSchema,
    from_warehouse_id: positiveIdSchema,
    to_warehouse_id: positiveIdSchema,
    reference: z.string().trim().max(100).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    lines: z.array(transferLineSchema).min(1).max(500),
  })
  .refine((value) => value.from_warehouse_id !== value.to_warehouse_id, {
    message: 'Gudang asal dan tujuan harus berbeda',
    path: ['to_warehouse_id'],
  })

export const adjustmentLineSchema = z.object({
  item_id: positiveIdSchema,
  unit_id: positiveIdSchema,
  actual_quantity: z.union([z.string(), z.number()]),
  gain_loss_account_id: positiveIdSchema.optional(),
  reason: z.string().trim().max(500).optional(),
})

export const stockAdjustmentSchema = z.object({
  adjustment_date: isoDateSchema,
  warehouse_id: positiveIdSchema,
  reason: z.string().trim().min(3).max(500),
  reference: z.string().trim().max(100).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  lines: z.array(adjustmentLineSchema).min(1).max(500),
})
