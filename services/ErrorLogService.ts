import { db } from '../config/database'
import { toJson } from '../utils/safe-json'

export interface ErrorLogInput {
  companyId?: number | null
  userId?: number | null
  requestId?: string | null
  level?: 'error' | 'warn' | 'info'
  category?: string | null
  message: string
  errorCode?: string | null
  stackTrace?: string | null
  context?: unknown
  path?: string | null
  method?: string | null
  ip?: string | null
}

export class ErrorLogService {
  async capture(input: ErrorLogInput) {
    await db.execute(
      `INSERT INTO error_logs (
         company_id, user_id, request_id, level, category, message, error_code,
         stack_trace, context, path, method, ip
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.companyId ?? null,
        input.userId ?? null,
        input.requestId ?? null,
        input.level ?? 'error',
        input.category ?? 'application',
        input.message.slice(0, 2000),
        input.errorCode ?? null,
        input.stackTrace?.slice(0, 16000) ?? null,
        toJson(input.context),
        input.path ?? null,
        input.method ?? null,
        input.ip ?? null,
      ],
    )
  }
}
