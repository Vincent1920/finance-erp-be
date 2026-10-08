import { db, transaction } from '../config/database'
import type { RowDataPacket } from 'mysql2/promise'
import { SettingsRepository, type SettingInput } from '../repositories/SettingsRepository'
import { BusinessValidationService } from './BusinessValidationService'
import { AuditService } from './AuditService'
import type { SystemActor } from './SystemUserService'
import { ConflictError, NotFoundError } from '../utils/AppError'
import { sequenceDefinitions, sequencePreview, type SequenceKey } from './NumberSequenceService'
import { settingCapability } from './SettingCapabilityService'
import { requiredAccountMappingKeys } from './AccountMappingService'

type RawSetting = {
  key: string
  value: unknown
  value_type: SettingInput['value_type']
  category: string
  is_secret: boolean
}

function serialize(input: RawSetting): string | null {
  if (input.value === null) return null
  switch (input.value_type) {
    case 'boolean':
      if (typeof input.value !== 'boolean') throw new ConflictError(`${input.key} harus boolean`)
      return input.value ? 'true' : 'false'
    case 'number':
    case 'account_id': {
      const number = Number(input.value)
      if(input.key==='security.session_timeout_minutes'&&(!Number.isInteger(number)||number<1||number>10080))throw new ConflictError('Batas sesi harus 1–10080 menit')
      if(input.key==='security.max_login_attempts'&&(!Number.isInteger(number)||number<1||number>100))throw new ConflictError('Batas login harus 1–100 kali')
      if (!Number.isFinite(number) || (input.value_type === 'account_id' && number <= 0))
        throw new ConflictError(`${input.key} harus berupa angka valid`)
      return String(number)
    }
    case 'json':
      return JSON.stringify(input.value)
    default:
      if (typeof input.value !== 'string') throw new ConflictError(`${input.key} harus berupa teks`)
      return input.value
  }
}

function deserialize(row: Record<string, unknown>) {
  const secret = Boolean(row.is_secret)
  let value: unknown = row.setting_value
  if (!secret && row.setting_value !== null) {
    if (row.value_type === 'boolean') value = row.setting_value === 'true'
    else if (row.value_type === 'number' || row.value_type === 'account_id')
      value = Number(row.setting_value)
    else if (row.value_type === 'json') {
      try {
        value = JSON.parse(String(row.setting_value))
      } catch {
        value = null
      }
    }
  }
  return {
    ...row,
    setting_value: secret ? null : value,
    configured: secret ? row.setting_value !== null && row.setting_value !== '' : undefined,
  }
}

export class SettingsService {
  constructor(
    private readonly settings = new SettingsRepository(),
    private readonly validation = new BusinessValidationService(),
    private readonly audit = new AuditService(),
  ) {}

  async list(companyId: number, category?: string) {
    return (await this.settings.list(companyId, category)).map((row) => ({
      ...deserialize(row),
      ...settingCapability(String(row.setting_key)),
    }))
  }

  async get(companyId: number, key: string) {
    const setting = await this.settings.find(companyId, key)
    if (!setting) throw new NotFoundError('Pengaturan tidak ditemukan')
    return deserialize(setting)
  }

  async updateMany(actor: SystemActor, inputs: RawSetting[]) {
    return transaction(async (connection) => {
      await connection.execute('SELECT id FROM companies WHERE id=? FOR UPDATE',[actor.companyId])
      const result = []
      for (const input of inputs) {
        const capability = settingCapability(input.key)
        if (!capability.editable)
          throw new ConflictError(`${input.key} belum didukung oleh proses transaksi dan belum dapat diubah`)
        const oldValue = await this.settings.find(actor.companyId, input.key, connection)
        const value = serialize(input)
        if(input.key==='accounting.transaction_lock_date' && (input.value_type!=='string' || (value && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) || (value && (Number.isNaN(Date.parse(String(value))) || new Date(String(value)).toISOString().slice(0,10)!==value)))) throw new ConflictError('Tanggal kunci harus YYYY-MM-DD atau kosong')
        if(input.key==='accounting.max_backdate_days' && (input.value_type!=='number'||!Number.isInteger(Number(value))||Number(value)<0||Number(value)>36500)) throw new ConflictError('Batas tanggal mundur harus 0 sampai 36.500 hari; 0 berarti tidak dibatasi')
        if(input.key==='accounting.allow_future_dates' && input.value_type!=='boolean') throw new ConflictError('Izin tanggal masa depan harus berupa ya/tidak')
        if(input.key==='accounting.posting_timezone' && (input.value_type!=='string'||!['Asia/Jakarta','Asia/Makassar','Asia/Jayapura'].includes(String(value)))) throw new ConflictError('Pilih zona waktu pembukuan yang tersedia')
        if(['accounting.fx_unrealized_gain_account_id','accounting.fx_unrealized_loss_account_id'].includes(input.key)){
          if(input.value_type!=='account_id')throw new ConflictError('Pilih akun selisih kurs atau kosongkan')
          if(value!==null){const [fxAccounts]=await connection.execute<RowDataPacket[]>('SELECT account_type FROM accounts WHERE id=? AND company_id=?',[Number(value),actor.companyId]);const types=input.key.includes('gain')?['revenue','other_income']:['expense','other_expense'];if(!types.includes(String(fxAccounts[0]?.account_type)))throw new ConflictError('Tipe akun laba/rugi selisih kurs tidak sesuai')}
        }
        if(input.key==='accounting.fx_rate_policy' && (input.value_type!=='string'||!['manual','registered'].includes(String(value))))throw new ConflictError('Pilih kebijakan kurs yang tersedia')
        if(input.key==='accounting.fx_max_rate_age_days' && (input.value_type!=='number'||!Number.isInteger(Number(value))||Number(value)<0||Number(value)>365))throw new ConflictError('Usia kurs harus 0–365 hari; 0 berarti tanggal yang sama')
        if(input.key==='accounting.fx_rate_source' && (input.value_type!=='string'||String(value).length>100))throw new ConflictError('Sumber kurs maksimal 100 karakter')
        if(input.key==='accounting.asset_capitalization_threshold' && (input.value_type!=='number'||!Number.isFinite(Number(value))||Number(value)<0))throw new ConflictError('Batas kapitalisasi harus nominal non-negatif')
        if(input.key==='accounting.default_asset_life_months' && (input.value_type!=='number'||!Number.isInteger(Number(value))||Number(value)<1||Number(value)>1200))throw new ConflictError('Umur manfaat harus 1–1200 bulan')
        if(input.key==='accounting.default_depreciation_method' && (input.value_type!=='string'||!['straight_line','declining_balance'].includes(String(value))))throw new ConflictError('Pilih metode penyusutan yang tersedia')
        if(input.key==='inventory.cost_method'){
          if(input.value_type!=='string'||!['weighted_average','fifo'].includes(String(value)))throw new ConflictError('Pilih FIFO atau rata-rata tertimbang')
          if(String(oldValue?.setting_value??'weighted_average')!==value){
            const [balances]=await connection.execute<RowDataPacket[]>('SELECT COUNT(*) total FROM inventory_balances WHERE company_id=? AND (quantity<>0 OR total_value<>0)',[actor.companyId])
            if(Number(balances[0]?.total)>0)throw new ConflictError('Metode HPP tidak dapat diubah selama masih ada saldo kuantitas/nilai persediaan. Perubahan dengan stok aktif memerlukan migrasi valuasi terkontrol, bukan mengganti metode langsung.')
          }
          const negative=inputs.find(s=>s.key==='allow_negative_stock')?.value??(await this.settings.find(actor.companyId,'allow_negative_stock',connection))?.setting_value
          if(value==='fifo'&&(negative===true||negative==='true'))throw new ConflictError('Nonaktifkan izin stok negatif sebelum memilih FIFO')
        }
        if(input.key==='allow_negative_stock'&&value==='true'){
          const method=inputs.find(s=>s.key==='inventory.cost_method')?.value??(await this.settings.find(actor.companyId,'inventory.cost_method',connection))?.setting_value
          if(method==='fifo')throw new ConflictError('FIFO tidak mengizinkan stok negatif')
        }
        if (input.value_type === 'account_id' && value !== null)
          await this.validation.ensureActiveReference(connection, {
            table: 'accounts',
            id: Number(value),
            companyId: actor.companyId,
            label: `Akun ${input.key}`,
            postingOnly: true,
          })
        const row = await this.settings.upsert(
          actor.companyId,
          { ...input, value },
          connection,
        )
        await this.audit.log(connection, {
          companyId: actor.companyId,
          userId: actor.id,
          module: 'settings',
          action: 'update',
          recordType: 'setting',
          recordId: Number(row?.id),
          oldValue: input.is_secret ? { configured: Boolean(oldValue?.setting_value) } : oldValue,
          newValue: input.is_secret ? { key: input.key, configured: value !== null } : row,
          requestId: actor.requestId,
          ip: actor.ip,
        })
        if (row) result.push(deserialize(row))
      }
      return result
    })
  }

  async accountingReadiness(companyId: number) {
    const checks = [
      {
        code: 'account-mappings', label: 'Pemetaan akun jurnal otomatis belum lengkap', link: '/settings',
        sql: `SELECT COUNT(*) total FROM (
                ${requiredAccountMappingKeys.map((_, index) => index === 0 ? 'SELECT ? mapping_key' : 'SELECT ?').join(' UNION ALL ')}
              ) required_keys LEFT JOIN account_mappings m ON m.company_id=? AND m.mapping_key=required_keys.mapping_key
              LEFT JOIN accounts a ON a.id=m.account_id AND a.company_id=m.company_id
              WHERE a.id IS NULL OR a.is_active=FALSE OR a.is_posting=FALSE OR a.deleted_at IS NOT NULL`,
        params: [...requiredAccountMappingKeys, companyId],
      },
      {
        code: 'customers', label: 'Pelanggan tanpa akun piutang aktif', link: '/master/customers',
        sql: `SELECT COUNT(*) total FROM customers x LEFT JOIN accounts a ON a.id=x.receivable_account_id AND a.company_id=x.company_id
              WHERE x.company_id=? AND x.deleted_at IS NULL AND x.is_active=TRUE AND (a.id IS NULL OR a.is_active=FALSE OR a.is_posting=FALSE OR a.deleted_at IS NOT NULL)`,
      },
      {
        code: 'suppliers', label: 'Pemasok tanpa akun utang aktif', link: '/master/suppliers',
        sql: `SELECT COUNT(*) total FROM suppliers x LEFT JOIN accounts a ON a.id=x.payable_account_id AND a.company_id=x.company_id
              WHERE x.company_id=? AND x.deleted_at IS NULL AND x.is_active=TRUE AND (a.id IS NULL OR a.is_active=FALSE OR a.is_posting=FALSE OR a.deleted_at IS NOT NULL)`,
      },
      {
        code: 'inventory-items', label: 'Barang persediaan dengan pemetaan akun belum lengkap', link: '/master/items',
        sql: `SELECT COUNT(*) total FROM items x
              LEFT JOIN accounts ia ON ia.id=x.inventory_account_id AND ia.company_id=x.company_id
              LEFT JOIN accounts ca ON ca.id=x.cogs_account_id AND ca.company_id=x.company_id
              LEFT JOIN accounts pa ON pa.id=x.purchase_account_id AND pa.company_id=x.company_id
              WHERE x.company_id=? AND x.deleted_at IS NULL AND x.is_active=TRUE AND x.item_type='inventory'
                AND (ia.id IS NULL OR ca.id IS NULL OR pa.id IS NULL OR ia.is_active=FALSE OR ca.is_active=FALSE OR pa.is_active=FALSE)`,
      },
      {
        code: 'bank-accounts', label: 'Rekening bank tanpa akun buku besar aktif', link: '/banking/accounts',
        sql: `SELECT COUNT(*) total FROM bank_accounts x LEFT JOIN accounts a ON a.id=x.gl_account_id AND a.company_id=x.company_id
              WHERE x.company_id=? AND x.deleted_at IS NULL AND x.is_active=TRUE AND (a.id IS NULL OR a.is_active=FALSE OR a.is_posting=FALSE OR a.deleted_at IS NOT NULL)`,
      },
      {
        code: 'asset-categories', label: 'Kategori aset dengan pemetaan akun belum lengkap', link: '/assets/fixed-assets',
        sql: `SELECT COUNT(*) total FROM fixed_asset_categories x
              LEFT JOIN accounts aa ON aa.id=x.asset_account_id AND aa.company_id=x.company_id
              LEFT JOIN accounts da ON da.id=x.accumulated_depreciation_account_id AND da.company_id=x.company_id
              LEFT JOIN accounts ea ON ea.id=x.depreciation_expense_account_id AND ea.company_id=x.company_id
              WHERE x.company_id=? AND x.is_active=TRUE AND (aa.id IS NULL OR da.id IS NULL OR ea.id IS NULL OR aa.is_active=FALSE OR da.is_active=FALSE OR ea.is_active=FALSE)`,
      },
      {
        code: 'payroll-policy', label: 'Kebijakan payroll aktif dengan akun belum lengkap', link: '/payroll',
        sql: `SELECT COUNT(*) total FROM payroll_policies x
              WHERE x.company_id=? AND x.effective_from=(SELECT MAX(p.effective_from) FROM payroll_policies p WHERE p.company_id=x.company_id)
                AND (x.salary_expense_account_id IS NULL OR x.employer_bpjs_expense_account_id IS NULL OR x.payroll_payable_account_id IS NULL OR x.bpjs_payable_account_id IS NULL OR x.pph21_payable_account_id IS NULL)`,
      },
    ]
    const rows = await Promise.all(checks.map(async (check) => {
      const [result] = await db.execute<RowDataPacket[]>(check.sql, 'params' in check ? check.params : [companyId])
      return { code: check.code, label: check.label, link: check.link, count: Number(result[0]?.total ?? 0) }
    }))
    return {
      ready: rows.every((row) => row.count === 0),
      issueCount: rows.reduce((sum, row) => sum + row.count, 0),
      checks: rows,
    }
  }

  company(companyId: number) {
    return this.settings.company(companyId)
  }

  async updateCompany(actor: SystemActor, input: Record<string, unknown>) {
    return transaction(async (connection) => {
      const oldValue = await this.settings.company(actor.companyId, connection)
      if (!oldValue) throw new NotFoundError('Perusahaan tidak ditemukan')
      const company = await this.settings.updateCompany(actor.companyId, input, connection)
      await this.audit.log(connection, {
        companyId: actor.companyId,
        userId: actor.id,
        module: 'settings',
        action: 'update_company',
        recordType: 'company',
        recordId: actor.companyId,
        oldValue,
        newValue: company,
        requestId: actor.requestId,
        ip: actor.ip,
      })
      return company
    })
  }

  async sequences(companyId: number) {
    const saved = await this.settings.sequences(companyId)
    const byKey = new Map(saved.map((row) => [String(row.sequence_key), row]))
    const today = new Date().toISOString().slice(0, 10)
    return Object.entries(sequenceDefinitions).map(([key, definition]) => {
      const row = byKey.get(key)
      const prefix = String(row?.prefix ?? definition.prefix)
      const padding = Number(row?.padding ?? 6)
      const currentNumber = Number(row?.current_number ?? 0)
      return {
        ...row,
        id: row?.id ?? null,
        sequence_key: key,
        label: definition.label,
        category: definition.category,
        prefix,
        padding,
        reset_period: row?.reset_period ?? 'monthly',
        current_number: currentNumber,
        last_reset_key: row?.last_reset_key ?? null,
        recommended_prefix: definition.prefix,
        preview: sequencePreview(prefix, padding, currentNumber + 1, today),
      }
    })
  }

  async upsertSequence(
    actor: SystemActor,
    input: {
      sequence_key: string
      prefix: string
      padding: number
      reset_period: string
    },
  ) {
    if (!sequenceDefinitions[input.sequence_key as SequenceKey])
      throw new ConflictError('Jenis dokumen tidak didukung')
    return transaction(async (connection) => {
      const row = await this.settings.upsertSequence(actor.companyId, input, connection)
      await this.audit.log(connection, {
        companyId: actor.companyId,
        userId: actor.id,
        module: 'settings',
        action: 'update_sequence',
        recordType: 'number_sequence',
        recordId: Number(row?.id),
        newValue: row,
        requestId: actor.requestId,
        ip: actor.ip,
      })
      return row
    })
  }
}
