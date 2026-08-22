import { createApp } from './config/app'
import { corsMiddleware } from './config/cors'
import { requestId } from './middleware/request-id.middleware'
import { loggerMiddleware } from './middleware/logger.middleware'
import { errorHandler } from './middleware/error.middleware'
import routes from './routes'
export const app = createApp()
app.use('*', requestId)
app.use('*', loggerMiddleware)
app.use('/api/*', corsMiddleware)
app.onError(errorHandler)
app.notFound((c) => c.json({ success: false, message: 'Endpoint tidak ditemukan' }, 404))
app.route('/api', routes)
