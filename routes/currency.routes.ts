import { z } from 'zod'
import { isoDateSchema } from '../validators/common.validator'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { CurrencyService } from '../services/CurrencyService'
import {
  currencyRateSchema,
  bankTransferSchema,
  bankRevalueSchema,
} from '../validators/currency.validator'
import { requirePermission } from '../middleware/permission.middleware'
import { operationContext } from '../controllers/OperationsController'
import { ok } from '../utils/response'
import { reversalOperationSchema } from '../validators/operations.validator'
const company = (c: Context) => c.get('user').companyId
// The authenticated company's base currency is required by settlement forms.
const route = new Hono(),
  service = new CurrencyService()
route.get('/options',async c=>ok(c,await service.options(company(c))))
route.get('/quote',async c=>{const input=z.object({currency:z.string().regex(/^[A-Z]{3}$/),date:isoDateSchema}).parse(c.req.query());return ok(c,await service.quote(company(c),input.currency,input.date))})
route.get('/base',async c=>ok(c,await service.baseCurrency(company(c))))
route.get('/', requirePermission('bank-accounts.view'), async (c) =>
  ok(c, await service.overview(company(c))),
)
route.put('/rates', requirePermission('settings.update'), async (c) =>
  ok(
    c,
    await service.saveRate(
      company(c),
      currencyRateSchema.parse(await c.req.json()),
      operationContext(c),
    ),
  ),
)
route.post('/transfers', requirePermission('bank-reconciliations.update'), async (c) =>
  ok(
    c,
    await service.transfer(
      company(c),
      bankTransferSchema.parse(await c.req.json()),
      operationContext(c),
    ),
  ),
)
route.post('/operations/:id/reverse', requirePermission('bank-reconciliations.update'), async (c) =>
  ok(
    c,
    await service.reverse(
      company(c),
      Number(c.req.param('id')),
      reversalOperationSchema.parse(await c.req.json()),
      operationContext(c),
    ),
  ),
)
route.post('/revaluation-preview', requirePermission('bank-accounts.view'), async (c) =>
  ok(
    c,
    await service.revalue(
      company(c),
      bankRevalueSchema.parse(await c.req.json()),
      operationContext(c),
      true,
    ),
  ),
)
route.post('/revaluations', requirePermission('bank-reconciliations.update'), async (c) =>
  ok(
    c,
    await service.revalue(
      company(c),
      bankRevalueSchema.parse(await c.req.json()),
      operationContext(c),
    ),
  ),
)
export default route
