import { transaction } from '../config/database'
import { SettingsRepository } from '../repositories/SettingsRepository'
import { AuditService } from './AuditService'
import type { PostingContext } from './PostingService'
import { ConflictError, NotFoundError, ValidationError } from '../utils/AppError'
type Profile = { id:string; name:string; version:number; template:Record<string,unknown>; updatedAt?:string }
type Profiles = { defaultId:string; profiles:Profile[] }

const documentTitles: Record<string, string> = {
  equity_changes: 'Laporan Perubahan Ekuitas',
  sales_invoice: 'Invoice Penjualan', purchase_invoice: 'Invoice Pembelian',
  sales_order: 'Sales Order', purchase_order: 'Purchase Order', payroll_slip: 'Slip Gaji',
  customer_payment_receipt: 'Kuitansi Pelunasan Penjualan', supplier_payment_voucher: 'Bukti Pelunasan Pembelian',
  general_journal: 'Jurnal Umum', general_ledger: 'Buku Besar', trial_balance: 'Neraca Saldo',
  profit_loss: 'Laporan Laba Rugi', balance_sheet: 'Laporan Posisi Keuangan', cash_flow: 'Laporan Arus Kas',
  stock_transfer: 'Bukti Transfer Stok', stock_adjustment: 'Bukti Penyesuaian Stok',
  fixed_asset_register: 'Daftar Aset Tetap', depreciation_schedule: 'Jadwal Penyusutan Aset',
  tax_reconciliation: 'Laporan Rekonsiliasi Pajak', month_end_report: 'Paket Laporan Tutup Bulan',
}

function defaultTemplate(documentType: string) {
  const reports = ['general_ledger', 'trial_balance', 'profit_loss', 'balance_sheet', 'cash_flow', 'fixed_asset_register', 'depreciation_schedule', 'tax_reconciliation', 'month_end_report']
  const commercial = ['sales_invoice', 'purchase_invoice', 'sales_order', 'purchase_order', 'customer_payment_receipt', 'supplier_payment_voucher'].includes(documentType)
  const landscape = ['general_ledger', 'trial_balance', 'fixed_asset_register', 'depreciation_schedule', 'tax_reconciliation', 'month_end_report'].includes(documentType)
  const payroll = documentType === 'payroll_slip'
  const report = reports.includes(documentType) || documentType === 'equity_changes'
  return {
    templateStyle: 'modern', fontSize: 10, pageSize: 'A4', orientation: landscape || documentType === 'equity_changes' ? 'landscape' : 'portrait', marginMm: 14,
    showCompany: true, showReference: !payroll && !report, showNotes: true, showTax: commercial,
    showSignature: true, showPaymentInfo: false, showPageNumber: true,
    headerTitle: documentTitles[documentType] ?? '', accentColor: '#2563eb', paymentInfo: '', paymentTerms: '', paymentQr: '',
    partnerLabel: payroll ? 'Pegawai' : '', totalLabel: payroll ? 'Take Home Pay' : commercial ? 'Total' : '',
    signatureLabels: payroll ? ['Dibuat oleh', 'Disetujui oleh', 'Penerima'] : report ? ['Disusun oleh', 'Diperiksa oleh', 'Disetujui oleh'] : ['Dibuat oleh', 'Disetujui oleh', 'Diterima oleh'],
    columns: ['code', 'name', 'quantity', 'unit', 'price', 'tax', 'subtotal'], watermark: '',
    footer: payroll ? 'Dokumen ini bersifat rahasia dan diterbitkan oleh perusahaan.' : report ? 'Laporan dihasilkan dari transaksi yang telah diposting pada sistem.' : 'Dokumen ini dibuat oleh sistem dan dapat digunakan sebagai bukti administrasi.',
  }
}
export class PrintTemplateService {
  async get(companyId: number, documentType = 'sales_invoice', templateId?: string) {
    if (!documentTitles[documentType]) throw new ValidationError('Jenis dokumen tidak dikenal')
    const repo = new SettingsRepository(),
      [setting, company] = await Promise.all([
        repo.find(companyId, `document.print_template.${documentType}`),
        repo.company(companyId),
      ])
    const legacy = !setting && documentType === 'sales_invoice'
      ? await repo.find(companyId, 'document.print_template')
      : null
    const fallback = (setting ?? legacy)?.setting_value ? JSON.parse(String((setting ?? legacy)!.setting_value)) : defaultTemplate(documentType)
    const stored = await repo.find(companyId, `document.print_profiles.${documentType}`)
    const collection: Profiles = stored?.setting_value ? JSON.parse(String(stored.setting_value)) : {defaultId:'default', profiles:[{id:'default',name:'Standar',version:0,template:fallback}]}
    const selected = collection.profiles.find(p=>p.id===(templateId ?? collection.defaultId))
    if (!selected) throw new NotFoundError('Template cetak tidak ditemukan')
    return {
      template: selected.template,
      templateId:selected.id, templateName:selected.name, templateVersion:selected.version,
      defaultTemplateId:collection.defaultId,
      profiles:collection.profiles.map(({template,...profile})=>profile),
      defaults:defaultTemplate(documentType),
      company: company
          ? {
            name: company.name,
            base_currency: company.base_currency,
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
  save(companyId: number, documentType: string, template: Record<string, unknown>, context: PostingContext, profile: {templateId?:string;templateName:string;setDefault:boolean;templateVersion?:number} = {templateName:'Standar',setDefault:true}) {
    return transaction(async (connection) => {
      await connection.execute('SELECT id FROM companies WHERE id=? FOR UPDATE',[companyId])
      const repo=new SettingsRepository()
      // Read through the same locked transaction so concurrent saves cannot overwrite each other.
      const [stored] = await connection.execute<any[]>('SELECT setting_value FROM settings WHERE company_id=? AND setting_key=?',[companyId,`document.print_profiles.${documentType}`])
      const [legacySettings]=await connection.execute<any[]>('SELECT setting_value FROM settings WHERE company_id=? AND setting_key IN (?,?) ORDER BY setting_key DESC',[companyId,`document.print_template.${documentType}`,documentType==='sales_invoice'?'document.print_template':`document.print_template.${documentType}`])
      const fallback=legacySettings[0]?.setting_value?JSON.parse(String(legacySettings[0].setting_value)):defaultTemplate(documentType)
      const collection:Profiles=stored[0]?.setting_value?JSON.parse(String(stored[0].setting_value)):{defaultId:'default',profiles:[{id:'default',name:'Standar',version:0,template:fallback}]}
      const id=profile.templateId??collection.defaultId
      const previous=collection.profiles.find(p=>p.id===id)
      if(previous && profile.templateVersion!==undefined && previous.version!==profile.templateVersion) throw new ConflictError('Template telah diubah pengguna lain. Muat ulang sebelum menyimpan.')
      if(!previous && collection.profiles.length>=20) throw new ValidationError('Maksimal 20 template per jenis dokumen')
      const saved:Profile={id,name:profile.templateName,version:(previous?.version??0)+1,template,updatedAt:new Date().toISOString()}
      collection.profiles=collection.profiles.filter(p=>p.id!==id).concat(saved)
      if(profile.setDefault) collection.defaultId=id
      await repo.upsert(companyId,{key:`document.print_profiles.${documentType}`,value:JSON.stringify(collection),value_type:'json',category:'dokumen',is_secret:false},connection)
      if(collection.defaultId===id) {
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
      }
      await new AuditService().log(connection, {
        companyId,
        userId: context.userId,
        module: 'document-templates',
        action: 'update',
        recordType: 'print_template',
        newValue: { documentType, templateId:id,templateName:saved.name,version:saved.version,setDefault:profile.setDefault,...template },
      })
      return {...template,templateId:id,templateVersion:saved.version}
    })
  }
}
