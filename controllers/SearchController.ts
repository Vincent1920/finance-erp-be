import type { Context } from 'hono'
import { z } from 'zod'
import { SearchRepository } from '../repositories/SearchRepository'
import { ok, paginated } from '../utils/response'

const transactionQuery = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.string().trim().max(30).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
const searchQuery = z.object({ q: z.string().trim().min(2).max(100) })

export class SearchController {
  constructor(private repository = new SearchRepository()) {}
  transactions = async (c: Context) => {
    const query = transactionQuery.parse(c.req.query())
    const result = await this.repository.transactions(c.get('user').companyId, query)
    return paginated(c, result.rows, result)
  }
  global = async (c: Context) =>
    ok(c, await this.repository.global(c.get('user').companyId, searchQuery.parse(c.req.query()).q))
}
