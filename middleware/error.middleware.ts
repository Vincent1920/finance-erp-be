import type { ErrorHandler } from 'hono'
import { ZodError } from 'zod'

import { env } from '../config/env'
import { AppError } from '../utils/AppError'

export const errorHandler: ErrorHandler = (error, c) => {
  const requestId = c.get('requestId')

  if (error instanceof ZodError) {
    return c.json(
      { success: false, message: 'Validation failed', errors: error.flatten(), requestId },
      422,
    )
  }

  if (error instanceof AppError) {
    return c.json(
      { success: false, message: error.message, errors: error.errors, requestId },
      error.status as 400,
    )
  }

  console.error(`[${requestId}]`, error)

  return c.json(
    {
      success: false,
      message: 'Internal server error',
      requestId,
      ...(env.APP_ENV === 'development' ? { detail: error.message } : {}),
    },
    500,
  )
}
