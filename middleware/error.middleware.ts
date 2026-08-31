import type { ErrorHandler } from 'hono'
import { ZodError } from 'zod'

import { ErrorLogService } from '../services/ErrorLogService'
import { AppError } from '../utils/AppError'

interface DatabaseError extends Error {
  code?: string
  errno?: number
}

const errorLogs = new ErrorLogService()

async function captureUnexpected(error: DatabaseError, c: Parameters<ErrorHandler>[1]) {
  let user: { id: number; companyId: number } | undefined
  try {
    user = c.get('user')
  } catch {
    user = undefined
  }
  try {
    await errorLogs.capture({
      companyId: user?.companyId,
      userId: user?.id,
      requestId: c.get('requestId'),
      category: 'http',
      message: error.message || 'Unhandled error',
      errorCode: error.code,
      stackTrace: error.stack,
      context: { userAgent: c.req.header('user-agent') },
      path: c.req.path,
      method: c.req.method,
      ip:
        c.req.header('cf-connecting-ip') ??
        c.req.header('x-real-ip') ??
        c.req.header('x-forwarded-for')?.split(',')[0]?.trim(),
    })
  } catch (loggingError) {
    console.error(`[${c.get('requestId')}] gagal menyimpan error log`, loggingError)
  }
}

export const errorHandler: ErrorHandler = async (error, c) => {
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

  const databaseError = error as DatabaseError
  if (databaseError.code === 'ER_DUP_ENTRY') {
    return c.json(
      { success: false, message: 'Kode atau data unik sudah digunakan', requestId },
      409,
    )
  }
  if (
    databaseError.code === 'ER_ROW_IS_REFERENCED_2' ||
    databaseError.code === 'ER_NO_REFERENCED_ROW_2'
  ) {
    return c.json(
      { success: false, message: 'Relasi data tidak valid atau data masih digunakan', requestId },
      409,
    )
  }

  console.error(`[${requestId}]`, error)
  await captureUnexpected(databaseError, c)

  return c.json(
    {
      success: false,
      message: 'Internal server error',
      requestId,
    },
    500,
  )
}
