import { transaction } from '../config/database'
import { SettingsRepository, type SettingInput } from '../repositories/SettingsRepository'
import { BusinessValidationService } from './BusinessValidationService'
import { AuditService } from './AuditService'
import type { SystemActor } from './SystemUserService'
import { ConflictError, NotFoundError } from '../utils/AppError'

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
    return (await this.settings.list(companyId, category)).map(deserialize)
  }

  async get(companyId: number, key: string) {
    const setting = await this.settings.find(companyId, key)
    if (!setting) throw new NotFoundError('Pengaturan tidak ditemukan')
    return deserialize(setting)
  }

  async updateMany(actor: SystemActor, inputs: RawSetting[]) {
    return transaction(async (connection) => {
      const result = []
      for (const input of inputs) {
        const oldValue = await this.settings.find(actor.companyId, input.key, connection)
        const value = serialize(input)
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

  sequences(companyId: number) {
    return this.settings.sequences(companyId)
  }

  async upsertSequence(
    actor: SystemActor,
    input: {
      sequence_key: string
      prefix: string
      padding: number
      reset_period: string
      current_number?: number
    },
  ) {
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
