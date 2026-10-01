import { transaction } from '../config/database'
import { SettingsRepository } from '../repositories/SettingsRepository'
import { AuditService } from './AuditService'
import type { PostingContext } from './PostingService'
export class PrintTemplateService {
  async get(companyId: number, documentType = 'sales_invoice') {
    const repo = new SettingsRepository(),
      [setting, company] = await Promise.all([
        repo.find(companyId, `document.print_template.${documentType}`),
        repo.company(companyId),
      ])
    const legacy = setting ? null : await repo.find(companyId, 'document.print_template')
    return {
      template: (setting ?? legacy)?.setting_value ? JSON.parse(String((setting ?? legacy)!.setting_value)) : null,
      company: company
          ? {
            name: company.name,
            legal_name: company.legal_name,
            address: company.address,
            phone: company.phone,
            email: company.email,
            tax_number: company.tax_number,
            logo: company.logo,
          }
        : null,
    }
  }
  save(companyId: number, documentType: string, template: Record<string, unknown>, context: PostingContext) {
    return transaction(async (connection) => {
      await new SettingsRepository().upsert(
        companyId,
        {
          key: `document.print_template.${documentType}`,
          value: JSON.stringify(template),
          value_type: 'json',
          category: 'dokumen',
          is_secret: false,
        },
        connection,
      )
      await new AuditService().log(connection, {
        companyId,
        userId: context.userId,
        module: 'document-templates',
        action: 'update',
        recordType: 'print_template',
        newValue: { documentType, ...template },
      })
      return template
    })
  }
}
