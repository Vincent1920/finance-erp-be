import type { Context } from 'hono'
export const ok = <T>(c: Context, data: T, message = 'Data berhasil diambil') =>
  c.json({ success: true, message, data })
export const created = <T>(c: Context, data: T, message = 'Data berhasil dibuat') =>
  c.json({ success: true, message, data }, 201)
export const paginated = <T>(
  c: Context,
  data: T[],
  meta: { page: number; limit: number; total: number },
) =>
  c.json({ success: true, data, meta: { ...meta, totalPages: Math.ceil(meta.total / meta.limit) } })
