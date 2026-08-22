import { serve } from 'bun'
import { app } from './app'
import { env } from './config/env'
serve({ fetch: app.fetch, port: env.APP_PORT })
console.info(`${env.APP_NAME} API running on http://localhost:${env.APP_PORT}`)
