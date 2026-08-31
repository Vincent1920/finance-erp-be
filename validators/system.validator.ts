import { z } from 'zod'

const password = z
  .string()
  .min(8)
  .max(128)
  .refine((value) => /[A-Za-z]/.test(value) && /\d/.test(value), {
    message: 'Password harus mengandung huruf dan angka',
  })

export const createUserSchema = z.object({
  name: z.string().trim().min(2).max(150),
  email: z.string().trim().toLowerCase().email().max(191),
  password,
  status: z.enum(['active', 'inactive', 'locked']).default('active'),
  role_ids: z.array(z.coerce.number().int().positive()).max(50).default([]),
})

export const updateUserSchema = createUserSchema
  .omit({ password: true, role_ids: true, status: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Tidak ada perubahan')

export const userStatusSchema = z.object({ status: z.enum(['active', 'inactive', 'locked']) })
export const resetPasswordSchema = z.object({ password })
export const assignRolesSchema = z.object({
  role_ids: z.array(z.coerce.number().int().positive()).max(50),
})

export const createRoleSchema = z.object({
  name: z.string().trim().min(2).max(100),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().max(5000).nullable().optional(),
  is_active: z.boolean().default(true),
  permission_ids: z.array(z.coerce.number().int().positive()).max(500).default([]),
})

export const updateRoleSchema = createRoleSchema
  .omit({ permission_ids: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Tidak ada perubahan')

export const assignPermissionsSchema = z.object({
  permission_ids: z.array(z.coerce.number().int().positive()).max(500),
})

export const createPermissionSchema = z.object({
  module: z.string().trim().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  action: z.string().trim().min(1).max(50).regex(/^[a-z0-9_]+$/),
  name: z.string().trim().min(2).max(150),
})

export const updatePermissionSchema = createPermissionSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Tidak ada perubahan')

export const settingEntrySchema = z.object({
  key: z.string().trim().min(1).max(191).regex(/^[a-z0-9_.-]+$/),
  value: z.unknown().nullable(),
  value_type: z.enum(['string', 'number', 'boolean', 'json', 'account_id']).default('string'),
  category: z.string().trim().min(1).max(50).default('general'),
  is_secret: z.boolean().default(false),
})

export const settingsBulkSchema = z.object({ settings: z.array(settingEntrySchema).min(1).max(200) })

export const companyProfileSchema = z.object({
  name: z.string().trim().min(2).max(150).optional(),
  legal_name: z.string().trim().max(191).nullable().optional(),
  tax_number: z.string().trim().max(50).nullable().optional(),
  address: z.string().trim().max(5000).nullable().optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  email: z.string().trim().email().max(191).nullable().optional(),
  logo: z.string().trim().max(255).nullable().optional(),
  base_currency: z.string().trim().length(3).transform((value) => value.toUpperCase()).optional(),
  fiscal_year_start: z.coerce.number().int().min(1).max(12).optional(),
})

export const sequenceSchema = z.object({
  sequence_key: z.string().trim().min(1).max(100).regex(/^[a-z0-9_-]+$/),
  prefix: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9{}\/_-]+$/),
  padding: z.coerce.number().int().min(1).max(12).default(6),
  reset_period: z.enum(['never', 'yearly', 'monthly']).default('yearly'),
  current_number: z.coerce.number().int().nonnegative().optional(),
})

export const resolveErrorSchema = z.object({
  notes: z.string().trim().min(2).max(5000),
})
