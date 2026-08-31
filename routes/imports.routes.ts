import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'

import { ImportController } from '../controllers/ImportController'

const route = new Hono()
const controller = new ImportController()

route.get('/config', controller.config)
route.get('/templates/:type', controller.template)
route.post(
  '/preview',
  bodyLimit({
    maxSize: 6 * 1024 * 1024,
    onError: (c) =>
      c.json({ success: false, message: 'Ukuran upload melebihi batas 5 MB' }, 413),
  }),
  controller.preview,
)
route.get('/', controller.list)
route.get('/:id/rows', controller.rows)
route.get('/:id/errors', controller.errors)
route.post('/:id/confirm', controller.confirm)
route.post('/:id/cancel', controller.cancel)
route.get('/:id', controller.get)

export default route
