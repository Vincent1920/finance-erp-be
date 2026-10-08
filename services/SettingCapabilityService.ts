export type SettingCapability = 'enforced' | 'reference' | 'planned'

const enforced = new Set([
  'security.session_timeout_minutes',
  'security.max_login_attempts',
  'accounting.fx_unrealized_gain_account_id',
  'accounting.fx_unrealized_loss_account_id',
  'accounting.fx_rate_policy',
  'accounting.fx_max_rate_age_days',
  'accounting.fx_rate_source',
  'accounting.asset_capitalization_threshold',
  'accounting.default_asset_life_months',
  'accounting.default_depreciation_method',
  'accounting.transaction_lock_date',
  'accounting.max_backdate_days',
  'accounting.allow_future_dates',
  'accounting.posting_timezone',
  'inventory.cost_method',
  'accounting.bypass_workflow',
  'accounting.allow_self_approval',
  'sales.block_over_credit_limit',
  'purchases.require_purchase_order',
  'allow_negative_stock',
])

const reference = new Set([
  'accounts_receivable_account_id',
  'accounts_payable_account_id',
  'default_cash_account_id',
  'default_bank_account_id',
  'bank_fee_expense_account_id',
  'inventory_account_id',
  'cost_of_goods_sold_account_id',
  'sales_revenue_account_id',
  'salary_expense_account_id',
])

export function settingCapability(key: string): {
  capability: SettingCapability
  capabilityNote: string
  editable: boolean
} {
  if(key==='security.session_timeout_minutes')return {capability:'enforced',editable:true,capabilityNote:'Batas sesi tanpa aktivitas API; 1–10080 menit. Masa berlaku maksimum token tetap mengikuti konfigurasi server.'}
  if(key==='security.max_login_attempts')return {capability:'enforced',editable:true,capabilityNote:'Batas kegagalan login per akun; 1–100 kali. Akun dapat mencoba kembali setelah 15 menit. Batas per koneksi juga berlaku.'}
  if(key.startsWith('accounting.fx_'))return {capability:'enforced',editable:true,capabilityNote:'Kurs terdaftar divalidasi saat posting dan revaluasi, sesuai tanggal, usia, dan sumber. Akun revaluasi kosong memakai mapping FX_GAIN/FX_LOSS. Kurs historis jurnal tetap tersimpan.'}
  if(['accounting.asset_capitalization_threshold','accounting.default_asset_life_months','accounting.default_depreciation_method'].includes(key))return {capability:'enforced',editable:true,capabilityNote:'Berlaku untuk aset baru. Umur dapat diisi per aset; metode disimpan saat perolehan. Penyusutan mulai satu bulan penuh pada bulan digunakan; saldo menurun ganda beralih ke garis lurus untuk menyelesaikan umur manfaat. Di bawah batas kapitalisasi dicatat sebagai beban melalui pembelian.'}
  if(key==='inventory.cost_method')return {capability:'enforced',editable:true,capabilityNote:'FIFO memakai layer biaya masuk paling lama; rata-rata memakai biaya tertimbang bergerak per barang/gudang. Perubahan metode hanya diizinkan ketika semua saldo stok dan nilainya nol. FIFO melarang stok negatif dan mutasi bertanggal mundur.'}
  if (enforced.has(key))
    return {
      capability: 'enforced',
      capabilityNote: 'Diterapkan dan divalidasi pada proses transaksi.',
      editable: true,
    }
  if (reference.has(key))
    return {
      capability: 'reference',
      capabilityNote: 'Disimpan sebagai acuan. Pemetaan akun pada master transaksi tetap menjadi sumber utama.',
      editable: true,
    }
  return {
    capability: 'planned',
    capabilityNote: 'Belum memengaruhi perhitungan atau validasi transaksi. Pengaturan dikunci sampai implementasinya tersedia.',
    editable: false,
  }
}
