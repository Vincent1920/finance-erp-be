import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'

import { db } from '../config/database'
import type { DatabaseValue, QueryExecutor } from '../types/database'
import type { ImportType } from '../services/import/ImportDefinitions'

export type ImportJobStatus =
  | 'uploaded'
  | 'validating'
  | 'validation_failed'
  | 'ready'
  | 'importing'
  | 'processing'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancelled'

export type PreviewSeverity = 'warning' | 'error'
export type PreviewRowStatus = 'valid' | PreviewSeverity

export interface PreviewIssue {
  field: string | null
  value: string | null
  severity: PreviewSeverity
  code: string
  message: string
}

export interface PreviewRowWrite {
  rowNumber: number
  status: PreviewRowStatus
  documentKey: string | null
  reference: string | null
  description: string | null
  isDuplicate: boolean
  data: Record<string, unknown>
  issues: PreviewIssue[]
}

interface ImportJobDbRow extends RowDataPacket {
  id: number
  company_id: number
  import_number: string
  entity_type: ImportType
  file_name: string
  status: ImportJobStatus
  total_rows: number
  valid_rows: number
  warning_rows: number
  invalid_rows: number
  imported_rows: number
  failed_rows: number
  import_as: 'draft' | 'submitted' | null
  error_policy: 'all_or_nothing' | 'valid_only' | null
  skip_duplicates: number | boolean
  validation_summary: unknown
  requested_by: number
  requested_by_name?: string
  started_at: Date | string | null
  completed_at: Date | string | null
  error_message: string | null
  created_at: Date | string
  expires_at: Date | string | null
  payload_deleted_at: Date | string | null
}

interface ImportPreviewDbRow extends RowDataPacket {
  id: number
  source_row_number: number
  row_status: PreviewRowStatus
  document_key: string | null
  reference: string | null
  description: string | null
  is_duplicate: number | boolean
  normalized_data: unknown
  issues: unknown
}

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }
  return value as T
}

const dateValue = (value: Date | string | null) =>
  value instanceof Date ? value.toISOString() : value ? String(value) : null

export function mapImportJob(row: ImportJobDbRow) {
  return {
    id: Number(row.id),
    importNumber: row.import_number,
    importType: row.entity_type,
    fileName: row.file_name,
    status: row.status,
    totalRows: Number(row.total_rows),
    validRows: Number(row.valid_rows),
    warningRows: Number(row.warning_rows),
    errorRows: Number(row.invalid_rows),
    importedRows: Number(row.imported_rows),
    failedRows: Number(row.failed_rows),
    importAs: row.import_as,
    errorPolicy: row.error_policy,
    skipDuplicates: Boolean(row.skip_duplicates),
    validationSummary: parseJson<Record<string, unknown> | null>(row.validation_summary, null),
    requestedBy: Number(row.requested_by),
    requestedByName: row.requested_by_name ?? null,
    uploadedAt: dateValue(row.created_at),
    startedAt: dateValue(row.started_at),
    completedAt: dateValue(row.completed_at),
    expiresAt: dateValue(row.expires_at),
    payloadDeletedAt: dateValue(row.payload_deleted_at),
    errorMessage: row.error_message,
  }
}

export function mapPreviewRow(row: ImportPreviewDbRow) {
  return {
    id: Number(row.id),
    rowNumber: Number(row.source_row_number),
    status: row.row_status,
    documentKey: row.document_key,
    reference: row.reference,
    description: row.description,
    isDuplicate: Boolean(row.is_duplicate),
    data: parseJson<Record<string, unknown>>(row.normalized_data, {}),
    issues: parseJson<PreviewIssue[]>(row.issues, []),
  }
}

export class ImportRepository {
  async createJob(input: {
    companyId: number
    importNumber: string
    type: ImportType
    fileName: string
    checksum: string
    requestedBy: number
  }) {
    const [result] = await db.execute<ResultSetHeader>(
      `INSERT INTO import_jobs(
        company_id, import_number, entity_type, file_name, storage_path, checksum,
        status, requested_by, started_at, expires_at
      ) VALUES (?, ?, ?, ?, '', ?, 'processing', ?, NOW(), DATE_ADD(NOW(), INTERVAL 24 HOUR))`,
      [
        input.companyId,
        input.importNumber,
        input.type,
        input.fileName,
        input.checksum,
        input.requestedBy,
      ],
    )
    return result.insertId
  }

  async find(
    id: number,
    companyId: number,
    requestedBy?: number,
    connection: QueryExecutor = db,
    forUpdate = false,
  ) {
    const ownerCondition = requestedBy ? 'AND j.requested_by = ?' : ''
    const values: DatabaseValue[] = [id, companyId]
    if (requestedBy) values.push(requestedBy)
    const [rows] = await connection.execute<ImportJobDbRow[]>(
      `SELECT j.*, u.name AS requested_by_name
       FROM import_jobs j
       INNER JOIN users u ON u.id = j.requested_by
       WHERE j.id = ? AND j.company_id = ? ${ownerCondition}
       LIMIT 1 ${forUpdate ? 'FOR UPDATE' : ''}`,
      values,
    )
    return rows[0] ?? null
  }

  async list(
    companyId: number,
    query: {
      page: number
      limit: number
      type?: ImportType
      status?: ImportJobStatus
      allowedTypes?: ImportType[]
    },
  ) {
    const conditions = ['j.company_id = ?']
    const values: DatabaseValue[] = [companyId]
    if (query.type) {
      conditions.push('j.entity_type = ?')
      values.push(query.type)
    }
    if (query.status) {
      conditions.push('j.status = ?')
      values.push(query.status)
    }
    if (query.allowedTypes && query.allowedTypes.length > 0) {
      conditions.push(`j.entity_type IN (${query.allowedTypes.map(() => '?').join(',')})`)
      values.push(...query.allowedTypes)
    }
    const where = conditions.join(' AND ')
    const offset = (query.page - 1) * query.limit
    const [rows] = await db.query<ImportJobDbRow[]>(
      `SELECT j.*, u.name AS requested_by_name
       FROM import_jobs j
       INNER JOIN users u ON u.id = j.requested_by
       WHERE ${where}
       ORDER BY j.created_at DESC, j.id DESC
       LIMIT ${query.limit} OFFSET ${offset}`,
      values,
    )
    const [counts] = await db.execute<(RowDataPacket & { total: number })[]>(
      `SELECT COUNT(*) AS total FROM import_jobs j WHERE ${where}`,
      values,
    )
    return {
      rows: rows.map(mapImportJob),
      total: Number(counts[0]?.total ?? 0),
      page: query.page,
      limit: query.limit,
    }
  }

  async savePreview(
    connection: QueryExecutor,
    jobId: number,
    rows: PreviewRowWrite[],
    summary: {
      validRows: number
      warningRows: number
      errorRows: number
      warnings: string[]
    },
  ) {
    await connection.execute('DELETE FROM import_job_errors WHERE import_job_id = ?', [jobId])
    await connection.execute('DELETE FROM import_job_rows WHERE import_job_id = ?', [jobId])

    for (const row of rows) {
      await connection.execute(
        `INSERT INTO import_job_rows(
          import_job_id, source_row_number, row_status, document_key, reference,
          description, is_duplicate, normalized_data, issues
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          jobId,
          row.rowNumber,
          row.status,
          row.documentKey,
          row.reference,
          row.description,
          row.isDuplicate,
          JSON.stringify(row.data),
          row.issues.length ? JSON.stringify(row.issues) : null,
        ],
      )
      for (const issue of row.issues) {
        await connection.execute(
          `INSERT INTO import_job_errors(
            import_job_id, source_row_number, field_name, field_value,
            severity, error_code, error_message, row_data
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
          [
            jobId,
            row.rowNumber,
            issue.field,
            issue.value?.slice(0, 1000) ?? null,
            issue.severity,
            issue.code,
            issue.message.slice(0, 1000),
          ],
        )
      }
    }

    await connection.execute(
      `UPDATE import_jobs
       SET status = ?, total_rows = ?, valid_rows = ?, warning_rows = ?, invalid_rows = ?,
           failed_rows = ?, validation_summary = ?, error_message = NULL
       WHERE id = ?`,
      [
        summary.errorRows > 0 ? 'validation_failed' : 'ready',
        rows.length,
        summary.validRows,
        summary.warningRows,
        summary.errorRows,
        summary.errorRows,
        JSON.stringify({ fileWarnings: summary.warnings }),
        jobId,
      ],
    )
  }

  async markFailed(id: number, message: string) {
    await db.execute(
      `UPDATE import_jobs
       SET status = 'failed', error_message = ?, completed_at = NOW()
       WHERE id = ?`,
      [message.slice(0, 2000), id],
    )
  }

  async rows(
    jobId: number,
    query: { page: number; limit: number; status?: PreviewRowStatus | 'duplicate' },
    connection: QueryExecutor = db,
  ) {
    const conditions = ['import_job_id = ?']
    const values: DatabaseValue[] = [jobId]
    if (query.status === 'duplicate') {
      conditions.push('is_duplicate = TRUE')
    } else if (query.status) {
      conditions.push('row_status = ?')
      values.push(query.status)
    }
    const where = conditions.join(' AND ')
    const offset = (query.page - 1) * query.limit
    const [rows] = await connection.execute<ImportPreviewDbRow[]>(
      `SELECT * FROM import_job_rows
       WHERE ${where}
       ORDER BY source_row_number
       LIMIT ? OFFSET ?`,
      [...values, query.limit, offset],
    )
    const [counts] = await connection.execute<(RowDataPacket & { total: number })[]>(
      `SELECT COUNT(*) AS total FROM import_job_rows WHERE ${where}`,
      values,
    )
    return {
      rows: rows.map(mapPreviewRow),
      total: Number(counts[0]?.total ?? 0),
      page: query.page,
      limit: query.limit,
    }
  }

  async allRows(jobId: number, connection: QueryExecutor = db) {
    const [rows] = await connection.execute<ImportPreviewDbRow[]>(
      `SELECT * FROM import_job_rows WHERE import_job_id = ? ORDER BY source_row_number`,
      [jobId],
    )
    return rows.map(mapPreviewRow)
  }

  async errors(jobId: number) {
    const [rows] = await db.execute<
      Array<
        RowDataPacket & {
          source_row_number: number
          field_name: string | null
          field_value: string | null
          severity: PreviewSeverity
          error_code: string | null
          error_message: string
        }
      >
    >(
      `SELECT source_row_number, field_name, field_value, severity, error_code, error_message
       FROM import_job_errors
       WHERE import_job_id = ?
       ORDER BY source_row_number, id`,
      [jobId],
    )
    return rows.map((row) => ({
      rowNumber: Number(row.source_row_number),
      field: row.field_name,
      value: row.field_value,
      severity: row.severity,
      code: row.error_code,
      message: row.error_message,
    }))
  }

  async cancel(id: number, companyId: number, requestedBy: number) {
    const [result] = await db.execute<ResultSetHeader>(
      `UPDATE import_jobs
       SET status = 'cancelled', completed_at = NOW(), payload_deleted_at = NOW()
       WHERE id = ? AND company_id = ? AND requested_by = ?
         AND status IN ('uploaded','validating','validation_failed','ready','processing')`,
      [id, companyId, requestedBy],
    )
    if (result.affectedRows) {
      await db.execute('DELETE FROM import_job_rows WHERE import_job_id = ?', [id])
      await db.execute('DELETE FROM import_job_errors WHERE import_job_id = ?', [id])
    }
    return result.affectedRows > 0
  }

  async cleanupExpired() {
    const [rows] = await db.execute<(RowDataPacket & { id: number })[]>(
      `SELECT id FROM import_jobs
       WHERE expires_at IS NOT NULL AND expires_at < NOW() AND payload_deleted_at IS NULL
       LIMIT 100`,
    )
    for (const row of rows) {
      await db.execute('DELETE FROM import_job_rows WHERE import_job_id = ?', [row.id])
      await db.execute('DELETE FROM import_job_errors WHERE import_job_id = ?', [row.id])
      await db.execute('UPDATE import_jobs SET payload_deleted_at = NOW() WHERE id = ?', [row.id])
    }
  }
}
