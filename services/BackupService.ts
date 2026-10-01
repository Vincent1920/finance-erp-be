import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { db, transaction } from '../config/database'
import { env } from '../config/env'
import { ConflictError, NotFoundError, ValidationError } from '../utils/AppError'
import { NumberSequenceService } from './NumberSequenceService'
import type { PostingContext } from './PostingService'

type BackupTable = { createSql?: string; rows?: Array<Record<string, unknown>> }
export type BackupDocument = {
  format: 'finora-portable-backup-v1'
  database: string
  createdAt: string
  type: 'full' | 'schema' | 'data'
  tables: Record<string, BackupTable>
}
const safeName = (name: string) => {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new ValidationError('Nama tabel backup tidak valid')
  return `\`${name}\``
}
const encode = (_key: string, value: unknown) =>
  typeof value === 'bigint'
    ? value.toString()
    : Buffer.isBuffer(value)
      ? { __buffer: value.toString('base64') }
      : value
const decode = (_key: string, value: unknown) =>
  value && typeof value === 'object' && '__buffer' in value
    ? Buffer.from(String((value as { __buffer: unknown }).__buffer), 'base64')
    : value

export function validateBackupDocument(
  document: unknown,
  expectedDatabase: string,
  requireFull = false,
) {
  if (!document || typeof document !== 'object') throw new ValidationError('Isi backup tidak valid')
  const backup = document as Partial<BackupDocument>
  if (backup.format !== 'finora-portable-backup-v1' || !backup.tables)
    throw new ValidationError('Format backup tidak didukung')
  if (backup.database !== expectedDatabase)
    throw new ValidationError('Backup berasal dari database yang berbeda')
  if (!['full', 'schema', 'data'].includes(String(backup.type)))
    throw new ValidationError('Jenis backup tidak didukung')
  if (requireFull && backup.type !== 'full')
    throw new ValidationError('Pemulihan database hanya menerima backup penuh')
  const required = ['migrations', 'companies', 'users', 'accounts', 'journals', 'journal_lines']
  const missing = required.filter((table) => !backup.tables?.[table])
  if (missing.length)
    throw new ValidationError(
      `Backup tidak lengkap. Tabel wajib tidak tersedia: ${missing.join(', ')}`,
    )
  if (backup.type === 'full') {
    const invalidSchema = Object.entries(backup.tables).find(
      ([, table]) => !table?.createSql || !Array.isArray(table.rows),
    )
    if (invalidSchema)
      throw new ValidationError(`Struktur atau data tabel ${invalidSchema[0]} tidak lengkap`)
  }
  return backup as BackupDocument
}

export class BackupService {
  async list(companyId: number) {
    const [rows] = await db.execute<RowDataPacket[]>(
      'SELECT id,backup_number,type,status,file_name,file_size,checksum,created_at,completed_at,error_message FROM backup_jobs WHERE company_id=? ORDER BY id DESC LIMIT 100',
      [companyId],
    )
    return rows
  }

  create(companyId: number, type: 'full' | 'schema' | 'data', context: PostingContext) {
    return transaction(async (connection) => {
      const number = await new NumberSequenceService().next(
        connection,
        companyId,
        'backup',
        new Date().toISOString().slice(0, 10),
      )
      const directory = resolve(process.cwd(), 'storage', 'backups')
      await mkdir(directory, { recursive: true })
      const fileName = `${number}.json`,
        path = resolve(directory, fileName)
      const [created] = await connection.execute<ResultSetHeader>(
        `INSERT INTO backup_jobs(company_id,backup_number,type,status,storage_disk,storage_path,file_name,requested_by,started_at) VALUES(?,?,?,'running','local',?,?,?,NOW())`,
        [companyId, number, type, path, fileName, context.userId],
      )
      try {
        const [tableRows] = await connection.execute<RowDataPacket[]>(
          "SELECT TABLE_NAME table_name FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME",
          [env.DB_NAME],
        )
        const document: BackupDocument = {
          format: 'finora-portable-backup-v1',
          database: env.DB_NAME,
          createdAt: new Date().toISOString(),
          type,
          tables: {},
        }
        for (const tableRow of tableRows) {
          const name = String(tableRow.table_name),
            table: BackupTable = {}
          if (type !== 'data') {
            const [definitions] = await connection.query<RowDataPacket[]>(
              `SHOW CREATE TABLE ${safeName(name)}`,
            )
            table.createSql = String(definitions[0]?.['Create Table'] ?? '')
          }
          if (type !== 'schema') {
            const [rows] = await connection.query<RowDataPacket[]>(
              `SELECT * FROM ${safeName(name)}`,
            )
            table.rows = rows as Array<Record<string, unknown>>
          }
          document.tables[name] = table
        }
        const content = JSON.stringify(document, encode)
        await writeFile(path, content, 'utf8')
        const checksum = createHash('sha256').update(content).digest('hex'),
          info = await stat(path)
        await connection.execute(
          "UPDATE backup_jobs SET status='completed',file_size=?,checksum=?,completed_at=NOW(),expires_at=DATE_ADD(NOW(),INTERVAL 90 DAY),metadata=? WHERE id=?",
          [
            info.size,
            checksum,
            JSON.stringify({
              format: document.format,
              tables: Object.keys(document.tables).length,
            }),
            created.insertId,
          ],
        )
        return {
          id: created.insertId,
          number,
          status: 'completed',
          fileName,
          fileSize: info.size,
          checksum,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 2000) : 'Backup gagal'
        await connection.execute(
          "UPDATE backup_jobs SET status='failed',error_message=?,completed_at=NOW() WHERE id=?",
          [message, created.insertId],
        )
        throw error
      }
    })
  }

  async file(companyId: number, id: number) {
    const [rows] = await db.execute<RowDataPacket[]>(
      "SELECT * FROM backup_jobs WHERE id=? AND company_id=? AND status='completed'",
      [id, companyId],
    )
    const backup = rows[0]
    if (!backup) throw new NotFoundError('Berkas backup tidak ditemukan')
    const path = resolve(String(backup.storage_path)),
      root = resolve(process.cwd(), 'storage', 'backups')
    if (!path.startsWith(`${root}\\`) && path !== root)
      throw new ValidationError('Lokasi backup tidak valid')
    return { backup, path }
  }

  async restore(
    companyId: number,
    backupId: number,
    confirmation: string,
    context: PostingContext,
  ) {
    const { backup, path } = await this.file(companyId, backupId)
    if (confirmation !== `RESTORE ${backup.backup_number}`)
      throw new ValidationError(`Ketik RESTORE ${backup.backup_number} untuk melanjutkan`)
    const content = await readFile(path, 'utf8'),
      checksum = createHash('sha256').update(content).digest('hex')
    if (checksum !== backup.checksum)
      throw new ConflictError('Checksum backup berubah; restore dibatalkan')
    let parsed: unknown
    try {
      parsed = JSON.parse(content, decode)
    } catch {
      throw new ValidationError('Berkas backup rusak dan tidak dapat dibaca')
    }
    const document = validateBackupDocument(parsed, env.DB_NAME, true)
    const number = `RST-${Date.now()}`
    const [created] = await db.execute<ResultSetHeader>(
      `INSERT INTO restore_jobs(company_id,restore_number,backup_job_id,storage_disk,storage_path,checksum,status,validation_result,requested_by,approved_by,approved_at,started_at) VALUES(?,?,?,'local',?,?,'running',?,?,?,NOW(),NOW())`,
      [
        companyId,
        number,
        backupId,
        path,
        checksum,
        JSON.stringify({ checksum: 'valid', source: backup.backup_number }),
        context.userId,
        context.userId,
      ],
    )
    const connection = await db.getConnection()
    try {
      await connection.query('SET FOREIGN_KEY_CHECKS=0')
      if (document.type !== 'data') {
        const [current] = await connection.execute<RowDataPacket[]>(
          "SELECT TABLE_NAME table_name FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE'",
          [env.DB_NAME],
        )
        for (const row of current)
          await connection.query(`DROP TABLE IF EXISTS ${safeName(String(row.table_name))}`)
        for (const [name, table] of Object.entries(document.tables)) {
          if (!table.createSql) throw new ValidationError(`Definisi tabel ${name} tidak tersedia`)
          await connection.query(table.createSql)
        }
      } else {
        for (const name of Object.keys(document.tables))
          await connection.query(`DELETE FROM ${safeName(name)}`)
      }
      if (document.type !== 'schema')
        for (const [name, table] of Object.entries(document.tables)) {
          for (const row of table.rows ?? []) {
            const columns = Object.keys(row)
            if (!columns.length) continue
            await connection.execute(
              `INSERT INTO ${safeName(name)}(${columns.map(safeName).join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
              columns.map((column) => row[column] as never),
            )
          }
        }
      await connection.query('SET FOREIGN_KEY_CHECKS=1')
      await connection.execute(
        `INSERT INTO restore_jobs(company_id,restore_number,backup_job_id,storage_disk,storage_path,checksum,status,validation_result,requested_by,approved_by,approved_at,started_at,completed_at)
        VALUES(?,?,?,'local',?,?,'completed',?,?,?,NOW(),NOW(),NOW()) ON DUPLICATE KEY UPDATE status='completed',completed_at=NOW()`,
        [
          companyId,
          number,
          backupId,
          path,
          checksum,
          JSON.stringify({ checksum: 'valid', source: backup.backup_number }),
          context.userId,
          context.userId,
        ],
      )
      connection.release()
      return { id: created.insertId, number, status: 'completed' }
    } catch (error) {
      await connection.query('SET FOREIGN_KEY_CHECKS=1')
      connection.release()
      const message = error instanceof Error ? error.message.slice(0, 2000) : 'Restore gagal'
      await db
        .execute(
          "UPDATE restore_jobs SET status='failed',error_message=?,completed_at=NOW() WHERE restore_number=?",
          [message, number],
        )
        .catch(() => undefined)
      throw error
    }
  }
}
