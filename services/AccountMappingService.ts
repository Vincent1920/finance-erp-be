import { assertGovernedChange } from './CoaControlService'
import type { RowDataPacket } from 'mysql2/promise'
import { db, transaction } from '../config/database'
import type { QueryExecutor } from '../types/database'
import type { DatabaseValue } from '../types/database'
import { ConflictError, ValidationError } from '../utils/AppError'
import { AuditService } from './AuditService'
import type { SystemActor } from './SystemUserService'

type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'cogs' | 'expense' | 'other_income' | 'other_expense'

export const accountMappingDefinitions = {
  PAID_IN_CAPITAL: { label: 'Modal disetor', types: ['equity'] },
  ADDITIONAL_PAID_IN_CAPITAL: { label: 'Tambahan modal disetor / agio', types: ['equity'] },
  DIVIDENDS_PAYABLE: { label: 'Utang dividen', types: ['liability'] },
  AR_CONTROL: { label: 'Piutang usaha', types: ['asset'] },
  AP_CONTROL: { label: 'Utang usaha', types: ['liability'] },
  INVENTORY: { label: 'Persediaan', types: ['asset'] },
  COGS: { label: 'Harga pokok penjualan', types: ['cogs', 'expense'] },
  REVENUE: { label: 'Pendapatan penjualan', types: ['revenue', 'other_income'] },
  PURCHASE_EXPENSE: { label: 'Beban pembelian/jasa', types: ['expense', 'other_expense'] },
  OUTPUT_VAT: { label: 'PPN keluaran', types: ['liability'] },
  INPUT_VAT: { label: 'PPN masukan', types: ['asset'] },
  WITHHOLDING_TAX: { label: 'Utang PPh', types: ['liability'] },
  CASH: { label: 'Kas', types: ['asset'] },
  BANK: { label: 'Bank', types: ['asset'] },
  BANK_FEE: { label: 'Biaya bank/MDR', types: ['expense', 'other_expense'] },
  FX_GAIN: { label: 'Laba selisih kurs', types: ['revenue', 'other_income'] },
  FX_LOSS: { label: 'Rugi selisih kurs', types: ['expense', 'other_expense'] },
  GRNI: { label: 'Barang diterima belum ditagih', types: ['liability'] },
  STOCK_GAIN: { label: 'Keuntungan penyesuaian stok', types: ['revenue', 'other_income'] },
  STOCK_LOSS: { label: 'Kerugian penyesuaian stok', types: ['expense', 'other_expense'] },
  RETAINED_EARNINGS: { label: 'Saldo laba', types: ['equity'] },
  CURRENT_YEAR_EARNINGS: { label: 'Laba tahun berjalan', types: ['equity'] },
} as const satisfies Record<string, { label: string; types: readonly AccountType[] }>

export type AccountMappingKey = keyof typeof accountMappingDefinitions

// Equity-specific mappings are validated when the feature is used, not required for every company to close a period.
export const requiredAccountMappingKeys = Object.keys(accountMappingDefinitions).filter(
  key => !['PAID_IN_CAPITAL', 'ADDITIONAL_PAID_IN_CAPITAL', 'DIVIDENDS_PAYABLE'].includes(key),
)

export class AccountMappingService {
  constructor(private audit = new AuditService()) {}

  async list(companyId: number, connection: QueryExecutor = db) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT m.id,m.mapping_key,m.account_id,m.description,a.code account_code,a.name account_name,
              a.account_type,a.is_active,a.is_posting
         FROM account_mappings m
         INNER JOIN accounts a ON a.id=m.account_id AND a.company_id=m.company_id
        WHERE m.company_id=? ORDER BY m.mapping_key`,
      [companyId],
    )
    const mapped = new Map(rows.map((row) => [String(row.mapping_key), row]))
    return Object.entries(accountMappingDefinitions).map(([key, definition]) => ({
      mapping_key: key,
      label: definition.label,
      allowed_types: definition.types,
      configured: mapped.has(key),
      ...(mapped.get(key) ?? { id: null, account_id: null, account_code: null, account_name: null }),
    }))
  }

  async ensureReadyFor(connection: QueryExecutor, companyId: number, keys: AccountMappingKey[]) {
    const missing: string[] = []
    for(const key of keys) {
      try { await this.resolve(connection,companyId,key) } catch(e) { missing.push(e instanceof Error ? e.message : key) }
    }
    if(missing.length) throw new ValidationError(`Pemetaan jurnal belum siap: ${missing.join('; ')}. Lengkapi Kendali COA sebelum bertransaksi.`)
  }

  async resolve(connection: QueryExecutor, companyId: number, key: AccountMappingKey, explicitId?: number | null) {
    await connection.execute('SELECT id FROM companies WHERE id=? LOCK IN SHARE MODE',[companyId])
    const values: DatabaseValue[] = [companyId]
    let sql = `SELECT a.id,a.account_type,a.is_active,a.is_posting,a.deleted_at
                 FROM accounts a`
    if (explicitId) {
      sql += ' WHERE a.company_id=? AND a.id=?'
      values.push(explicitId)
    } else {
      sql += ' INNER JOIN account_mappings m ON m.account_id=a.id AND m.company_id=a.company_id WHERE a.company_id=? AND m.mapping_key=?'
      values.push(key)
    }
    const [rows] = await connection.execute<RowDataPacket[]>(sql, values)
    const account = rows[0]
    if (!account) throw new ValidationError(`Pemetaan akun ${accountMappingDefinitions[key].label} belum dikonfigurasi`)
    if (!account.is_active || !account.is_posting || account.deleted_at)
      throw new ValidationError(`Akun ${accountMappingDefinitions[key].label} harus aktif dan dapat diposting`)
    if (!accountMappingDefinitions[key].types.includes(account.account_type as never))
      throw new ValidationError(`Tipe akun ${accountMappingDefinitions[key].label} tidak sesuai`)
    return Number(account.id)
  }

  async upsert(actor: SystemActor, key: AccountMappingKey, accountId: number, approved = false) {
    return transaction(connection => this.upsertInTransaction(connection,actor,key,accountId,approved))
  }

  async upsertInTransaction(connection: QueryExecutor, actor: SystemActor, key: AccountMappingKey, accountId: number, approved = false) {
      await assertGovernedChange(connection,actor.companyId,approved)
      await this.resolve(connection, actor.companyId, key, accountId)
      const [oldRows] = await connection.execute<RowDataPacket[]>(
        'SELECT * FROM account_mappings WHERE company_id=? AND mapping_key=? FOR UPDATE',
        [actor.companyId, key],
      )
      await connection.execute(
        `INSERT INTO account_mappings(company_id,mapping_key,account_id,description,created_by,updated_by)
         VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE account_id=VALUES(account_id),description=VALUES(description),updated_by=VALUES(updated_by)`,
        [actor.companyId, key, accountId, accountMappingDefinitions[key].label, actor.id, actor.id],
      )
      await this.audit.log(connection, {
        companyId: actor.companyId, userId: actor.id, module: 'settings', action: 'update_account_mapping',
        recordType: 'account_mapping', recordId: accountId, oldValue: oldRows[0] ?? null,
        newValue: { mappingKey: key, accountId }, requestId: actor.requestId, ip: actor.ip,
      })
      return (await this.list(actor.companyId, connection)).find((row) => row.mapping_key === key)
  }

  assertKey(value: string): AccountMappingKey {
    if (!(value in accountMappingDefinitions)) throw new ConflictError('Jenis pemetaan akun tidak didukung')
    return value as AccountMappingKey
  }
}
