import { Hono } from 'hono'
import type { ZodObject, ZodRawShape } from 'zod'
import { EntityController } from '../controllers/EntityController'
import type { EntityTable } from '../repositories/EntityRepository'
import { requirePermission } from '../middleware/permission.middleware'
export const entityRoutes = (
  table: EntityTable,
  module: string,
  schema: ZodObject<ZodRawShape>,
) => {
  const route = new Hono(),
    controller = new EntityController(table, schema)
  route.get('/', requirePermission(`${module}.view`), controller.list)
  route.post('/', requirePermission(`${module}.create`), controller.create)
  route.get('/:id', requirePermission(`${module}.view`), controller.get)
  route.put('/:id', requirePermission(`${module}.update`), controller.update)
  route.delete('/:id', requirePermission(`${module}.delete`), controller.remove)
  return route
}
