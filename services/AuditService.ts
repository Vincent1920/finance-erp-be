import { db } from '../config/database'
import type { QueryExecutor } from '../types/database'
import { toJson } from '../utils/safe-json'

export interface AuditInput {
  companyId?: number | null
  userId?: number | null
  module: string
  action: string
  recordType?: string | null
  recordId?: number | null
  recordNumber?: string | null
  oldValue?: unknown
  newValue?: unknown
  ip?: string | null
  requestId?: string | null
  requestMethod?: string | null
  requestPath?: string | null
  userAgent?: string | null
  metadata?: unknown
}

export class AuditService {
  async log(connection: QueryExecutor = db, input: AuditInput): Promise<void> {
    await connection.execute(
      `INSERT INTO audit_logs (
         company_id, user_id, module, action, record_type, record_id,
         record_number, old_value, new_value, ip, request_id,
         request_method, request_path, user_agent, metadata
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.companyId ?? null,
        input.userId ?? null,
        input.module,
        input.action,
        input.recordType ?? null,
        input.recordId ?? null,
        input.recordNumber ?? null,
        toJson(input.oldValue),
        toJson(input.newValue),
        input.ip ?? null,
        input.requestId ?? null,
        input.requestMethod ?? null,
        input.requestPath ?? null,
        input.userAgent ?? null,
        toJson(input.metadata),
      ],
    )
  }
}
