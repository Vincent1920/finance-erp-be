import type {AccountMappingKey} from '../services/AccountMappingService'
export type StandardCoaRow={code:string;name:string;type:string;parent:string|null;group:string|null;normal:string;mapping:AccountMappingKey|null;header:boolean}
export const standardCoa:StandardCoaRow[]=[
  {
    "code": "100000",
    "name": "Aset",
    "type": "asset",
    "parent": null,
    "group": null,
    "normal": "debit",
    "mapping": null,
    "header": true
  },
  {
    "code": "110000",
    "name": "Aset lancar",
    "type": "asset",
    "parent": "100000",
    "group": "current_assets",
    "normal": "debit",
    "mapping": null,
    "header": true
  },
  {
    "code": "111000",
    "name": "Kas dan setara kas",
    "type": "asset",
    "parent": "110000",
    "group": "cash_and_bank",
    "normal": "debit",
    "mapping": null,
    "header": true
  },
  {
    "code": "111001",
    "name": "Kas",
    "type": "asset",
    "parent": "111000",
    "group": "cash_and_bank",
    "normal": "debit",
    "mapping": "CASH",
    "header": false
  },
  {
    "code": "111101",
    "name": "Bank",
    "type": "asset",
    "parent": "111000",
    "group": "cash_and_bank",
    "normal": "debit",
    "mapping": "BANK",
    "header": false
  },
  {
    "code": "112000",
    "name": "Investasi jangka pendek",
    "type": "asset",
    "parent": "110000",
    "group": "short_term_investments",
    "normal": "debit",
    "mapping": null,
    "header": true
  },
  {
    "code": "112001",
    "name": "Investasi jangka pendek",
    "type": "asset",
    "parent": "112000",
    "group": "short_term_investments",
    "normal": "debit",
    "mapping": null,
    "header": false
  },
  {
    "code": "113000",
    "name": "Piutang usaha",
    "type": "asset",
    "parent": "110000",
    "group": "trade_receivables",
    "normal": "debit",
    "mapping": null,
    "header": true
  },
  {
    "code": "113001",
    "name": "Piutang usaha",
    "type": "asset",
    "parent": "113000",
    "group": "trade_receivables",
    "normal": "debit",
    "mapping": "AR_CONTROL",
    "header": false
  },
  {
    "code": "113002",
    "name": "Cadangan kerugian piutang",
    "type": "asset",
    "parent": "113000",
    "group": "trade_receivables",
    "normal": "credit",
    "mapping": null,
    "header": false
  },
  {
    "code": "114000",
    "name": "Piutang lainnya",
    "type": "asset",
    "parent": "110000",
    "group": "other_receivables",
    "normal": "debit",
    "mapping": null,
    "header": true
  },
  {
    "code": "114001",
    "name": "Piutang pegawai",
    "type": "asset",
    "parent": "114000",
    "group": "other_receivables",
    "normal": "debit",
    "mapping": null,
    "header": false
  },
  {
    "code": "115000",
    "name": "Persediaan",
    "type": "asset",
    "parent": "110000",
    "group": "inventory",
    "normal": "debit",
    "mapping": null,
    "header": true
  },
  {
    "code": "115001",
    "name": "Persediaan barang",
    "type": "asset",
    "parent": "115000",
    "group": "inventory",
    "normal": "debit",
    "mapping": "INVENTORY",
    "header": false
  },
  {
    "code": "116000",
    "name": "Biaya dibayar di muka",
    "type": "asset",
    "parent": "110000",
    "group": "prepaid_expenses",
    "normal": "debit",
    "mapping": null,
    "header": true
  },
  {
    "code": "116001",
    "name": "Biaya dibayar di muka",
    "type": "asset",
    "parent": "116000",
    "group": "prepaid_expenses",
    "normal": "debit",
    "mapping": null,
    "header": false
  },
  {
    "code": "117000",
    "name": "Pajak dibayar di muka",
    "type": "asset",
    "parent": "110000",
    "group": "prepaid_taxes",
    "normal": "debit",
    "mapping": null,
    "header": true
  },
  {
    "code": "117001",
    "name": "PPN masukan",
    "type": "asset",
    "parent": "117000",
    "group": "prepaid_taxes",
    "normal": "debit",
    "mapping": "INPUT_VAT",
    "header": false
  },
  {
    "code": "117002",
    "name": "Pajak penghasilan dibayar di muka",
    "type": "asset",
    "parent": "117000",
    "group": "prepaid_taxes",
    "normal": "debit",
    "mapping": null,
    "header": false
  },
  {
    "code": "120000",
    "name": "Aset tidak lancar",
    "type": "asset",
    "parent": "100000",
    "group": "non_current_assets",
    "normal": "debit",
    "mapping": null,
    "header": true
  },
  {
    "code": "121000",
    "name": "Aset tetap",
    "type": "asset",
    "parent": "120000",
    "group": "fixed_assets",
    "normal": "debit",
    "mapping": null,
    "header": true
  },
  {
    "code": "121001",
    "name": "Tanah",
    "type": "asset",
    "parent": "121000",
    "group": "fixed_assets",
    "normal": "debit",
    "mapping": null,
    "header": false
  },
  {
    "code": "121002",
    "name": "Bangunan",
    "type": "asset",
    "parent": "121000",
    "group": "fixed_assets",
    "normal": "debit",
    "mapping": null,
    "header": false
  },
  {
    "code": "121003",
    "name": "Peralatan kantor",
    "type": "asset",
    "parent": "121000",
    "group": "fixed_assets",
    "normal": "debit",
    "mapping": null,
    "header": false
  },
  {
    "code": "121004",
    "name": "Mesin",
    "type": "asset",
    "parent": "121000",
    "group": "fixed_assets",
    "normal": "debit",
    "mapping": null,
    "header": false
  },
  {
    "code": "121102",
    "name": "Akumulasi penyusutan bangunan",
    "type": "asset",
    "parent": "121000",
    "group": "fixed_assets",
    "normal": "credit",
    "mapping": null,
    "header": false
  },
  {
    "code": "121103",
    "name": "Akumulasi penyusutan peralatan kantor",
    "type": "asset",
    "parent": "121000",
    "group": "fixed_assets",
    "normal": "credit",
    "mapping": null,
    "header": false
  },
  {
    "code": "121104",
    "name": "Akumulasi penyusutan mesin",
    "type": "asset",
    "parent": "121000",
    "group": "fixed_assets",
    "normal": "credit",
    "mapping": null,
    "header": false
  },
  {
    "code": "122000",
    "name": "Aset takberwujud",
    "type": "asset",
    "parent": "120000",
    "group": "intangible_assets",
    "normal": "debit",
    "mapping": null,
    "header": true
  },
  {
    "code": "122001",
    "name": "Perangkat lunak",
    "type": "asset",
    "parent": "122000",
    "group": "intangible_assets",
    "normal": "debit",
    "mapping": null,
    "header": false
  },
  {
    "code": "122101",
    "name": "Akumulasi amortisasi perangkat lunak",
    "type": "asset",
    "parent": "122000",
    "group": "intangible_assets",
    "normal": "credit",
    "mapping": null,
    "header": false
  },
  {
    "code": "123000",
    "name": "Investasi jangka panjang",
    "type": "asset",
    "parent": "120000",
    "group": "long_term_investments",
    "normal": "debit",
    "mapping": null,
    "header": true
  },
  {
    "code": "123001",
    "name": "Investasi jangka panjang",
    "type": "asset",
    "parent": "123000",
    "group": "long_term_investments",
    "normal": "debit",
    "mapping": null,
    "header": false
  },
  {
    "code": "129000",
    "name": "Aset tidak lancar lainnya",
    "type": "asset",
    "parent": "120000",
    "group": "other_non_current_assets",
    "normal": "debit",
    "mapping": null,
    "header": true
  },
  {
    "code": "129001",
    "name": "Uang jaminan jangka panjang",
    "type": "asset",
    "parent": "129000",
    "group": "other_non_current_assets",
    "normal": "debit",
    "mapping": null,
    "header": false
  },
  {
    "code": "200000",
    "name": "Liabilitas",
    "type": "liability",
    "parent": null,
    "group": null,
    "normal": "credit",
    "mapping": null,
    "header": true
  },
  {
    "code": "210000",
    "name": "Liabilitas jangka pendek",
    "type": "liability",
    "parent": "200000",
    "group": "current_liabilities",
    "normal": "credit",
    "mapping": null,
    "header": true
  },
  {
    "code": "211000",
    "name": "Utang usaha dan penerimaan belum ditagih",
    "type": "liability",
    "parent": "210000",
    "group": "trade_payables",
    "normal": "credit",
    "mapping": null,
    "header": true
  },
  {
    "code": "211001",
    "name": "Utang usaha",
    "type": "liability",
    "parent": "211000",
    "group": "trade_payables",
    "normal": "credit",
    "mapping": "AP_CONTROL",
    "header": false
  },
  {
    "code": "211002",
    "name": "Barang diterima belum ditagih",
    "type": "liability",
    "parent": "211000",
    "group": "trade_payables",
    "normal": "credit",
    "mapping": "GRNI",
    "header": false
  },
  {
    "code": "212000",
    "name": "Utang pajak",
    "type": "liability",
    "parent": "210000",
    "group": "tax_payables",
    "normal": "credit",
    "mapping": null,
    "header": true
  },
  {
    "code": "212001",
    "name": "PPN keluaran",
    "type": "liability",
    "parent": "212000",
    "group": "tax_payables",
    "normal": "credit",
    "mapping": "OUTPUT_VAT",
    "header": false
  },
  {
    "code": "212002",
    "name": "Utang PPh",
    "type": "liability",
    "parent": "212000",
    "group": "tax_payables",
    "normal": "credit",
    "mapping": "WITHHOLDING_TAX",
    "header": false
  },
  {
    "code": "213000",
    "name": "Utang gaji dan BPJS",
    "type": "liability",
    "parent": "210000",
    "group": "current_liabilities",
    "normal": "credit",
    "mapping": null,
    "header": true
  },
  {
    "code": "213001",
    "name": "Utang gaji",
    "type": "liability",
    "parent": "213000",
    "group": "current_liabilities",
    "normal": "credit",
    "mapping": null,
    "header": false
  },
  {
    "code": "213002",
    "name": "Utang BPJS Kesehatan",
    "type": "liability",
    "parent": "213000",
    "group": "current_liabilities",
    "normal": "credit",
    "mapping": null,
    "header": false
  },
  {
    "code": "213003",
    "name": "Utang BPJS Ketenagakerjaan",
    "type": "liability",
    "parent": "213000",
    "group": "current_liabilities",
    "normal": "credit",
    "mapping": null,
    "header": false
  },
  {
    "code": "214000",
    "name": "Beban akrual",
    "type": "liability",
    "parent": "210000",
    "group": "current_liabilities",
    "normal": "credit",
    "mapping": null,
    "header": true
  },
  {
    "code": "214001",
    "name": "Beban masih harus dibayar",
    "type": "liability",
    "parent": "214000",
    "group": "current_liabilities",
    "normal": "credit",
    "mapping": null,
    "header": false
  },
  {
    "code": "215000",
    "name": "Pinjaman jangka pendek",
    "type": "liability",
    "parent": "210000",
    "group": "current_liabilities",
    "normal": "credit",
    "mapping": null,
    "header": true
  },
  {
    "code": "215001",
    "name": "Pinjaman bank jangka pendek",
    "type": "liability",
    "parent": "215000",
    "group": "current_liabilities",
    "normal": "credit",
    "mapping": null,
    "header": false
  },
  {
    "code": "216000",
    "name": "Utang dividen",
    "type": "liability",
    "parent": "210000",
    "group": "current_liabilities",
    "normal": "credit",
    "mapping": null,
    "header": true
  },
  {
    "code": "216001",
    "name": "Utang dividen",
    "type": "liability",
    "parent": "216000",
    "group": "current_liabilities",
    "normal": "credit",
    "mapping": "DIVIDENDS_PAYABLE",
    "header": false
  },
  {
    "code": "220000",
    "name": "Liabilitas jangka panjang",
    "type": "liability",
    "parent": "200000",
    "group": "non_current_liabilities",
    "normal": "credit",
    "mapping": null,
    "header": true
  },
  {
    "code": "221000",
    "name": "Pinjaman jangka panjang",
    "type": "liability",
    "parent": "220000",
    "group": "non_current_liabilities",
    "normal": "credit",
    "mapping": null,
    "header": true
  },
  {
    "code": "221001",
    "name": "Pinjaman bank jangka panjang",
    "type": "liability",
    "parent": "221000",
    "group": "non_current_liabilities",
    "normal": "credit",
    "mapping": null,
    "header": false
  },
  {
    "code": "222000",
    "name": "Liabilitas sewa jangka panjang",
    "type": "liability",
    "parent": "220000",
    "group": "non_current_liabilities",
    "normal": "credit",
    "mapping": null,
    "header": true
  },
  {
    "code": "222001",
    "name": "Liabilitas sewa jangka panjang",
    "type": "liability",
    "parent": "222000",
    "group": "non_current_liabilities",
    "normal": "credit",
    "mapping": null,
    "header": false
  },
  {
    "code": "300000",
    "name": "Ekuitas",
    "type": "equity",
    "parent": null,
    "group": null,
    "normal": "credit",
    "mapping": null,
    "header": true
  },
  {
    "code": "310000",
    "name": "Modal disetor",
    "type": "equity",
    "parent": "300000",
    "group": "equity",
    "normal": "credit",
    "mapping": null,
    "header": true
  },
  {
    "code": "310001",
    "name": "Modal disetor",
    "type": "equity",
    "parent": "310000",
    "group": "equity",
    "normal": "credit",
    "mapping": "PAID_IN_CAPITAL",
    "header": false
  },
  {
    "code": "310002",
    "name": "Tambahan modal disetor / agio",
    "type": "equity",
    "parent": "310000",
    "group": "equity",
    "normal": "credit",
    "mapping": "ADDITIONAL_PAID_IN_CAPITAL",
    "header": false
  },
  {
    "code": "320000",
    "name": "Saldo laba",
    "type": "equity",
    "parent": "300000",
    "group": "equity",
    "normal": "credit",
    "mapping": null,
    "header": true
  },
  {
    "code": "320001",
    "name": "Saldo laba",
    "type": "equity",
    "parent": "320000",
    "group": "equity",
    "normal": "credit",
    "mapping": "RETAINED_EARNINGS",
    "header": false
  },
  {
    "code": "330000",
    "name": "Laba tahun berjalan",
    "type": "equity",
    "parent": "300000",
    "group": "equity",
    "normal": "credit",
    "mapping": null,
    "header": true
  },
  {
    "code": "330001",
    "name": "Laba tahun berjalan",
    "type": "equity",
    "parent": "330000",
    "group": "equity",
    "normal": "credit",
    "mapping": "CURRENT_YEAR_EARNINGS",
    "header": false
  },
  {
    "code": "400000",
    "name": "Pendapatan usaha",
    "type": "revenue",
    "parent": null,
    "group": null,
    "normal": "credit",
    "mapping": null,
    "header": true
  },
  {
    "code": "410000",
    "name": "Penjualan dan jasa",
    "type": "revenue",
    "parent": "400000",
    "group": "operating_revenue",
    "normal": "credit",
    "mapping": null,
    "header": true
  },
  {
    "code": "410001",
    "name": "Penjualan",
    "type": "revenue",
    "parent": "410000",
    "group": "operating_revenue",
    "normal": "credit",
    "mapping": "REVENUE",
    "header": false
  },
  {
    "code": "410002",
    "name": "Retur dan potongan penjualan",
    "type": "revenue",
    "parent": "410000",
    "group": "operating_revenue",
    "normal": "debit",
    "mapping": null,
    "header": false
  },
  {
    "code": "500000",
    "name": "Harga pokok penjualan",
    "type": "cogs",
    "parent": null,
    "group": null,
    "normal": "debit",
    "mapping": null,
    "header": true
  },
  {
    "code": "510000",
    "name": "Harga pokok",
    "type": "cogs",
    "parent": "500000",
    "group": "cost_of_goods_sold",
    "normal": "debit",
    "mapping": null,
    "header": true
  },
  {
    "code": "510001",
    "name": "Harga pokok penjualan",
    "type": "cogs",
    "parent": "510000",
    "group": "cost_of_goods_sold",
    "normal": "debit",
    "mapping": "COGS",
    "header": false
  },
  {
    "code": "600000",
    "name": "Beban operasional dan pajak",
    "type": "expense",
    "parent": null,
    "group": null,
    "normal": "debit",
    "mapping": null,
    "header": true
  },
  {
    "code": "610000",
    "name": "Beban pegawai",
    "type": "expense",
    "parent": "600000",
    "group": "operating_expenses",
    "normal": "debit",
    "mapping": null,
    "header": true
  },
  {
    "code": "610001",
    "name": "Beban gaji",
    "type": "expense",
    "parent": "610000",
    "group": "operating_expenses",
    "normal": "debit",
    "mapping": null,
    "header": false
  },
  {
    "code": "610002",
    "name": "Beban uang makan",
    "type": "expense",
    "parent": "610000",
    "group": "operating_expenses",
    "normal": "debit",
    "mapping": null,
    "header": false
  },
  {
    "code": "610003",
    "name": "Beban BPJS Kesehatan perusahaan",
    "type": "expense",
    "parent": "610000",
    "group": "operating_expenses",
    "normal": "debit",
    "mapping": null,
    "header": false
  },
  {
    "code": "610004",
    "name": "Beban BPJS Ketenagakerjaan perusahaan",
    "type": "expense",
    "parent": "610000",
    "group": "operating_expenses",
    "normal": "debit",
    "mapping": null,
    "header": false
  },
  {
    "code": "620000",
    "name": "Beban operasional",
    "type": "expense",
    "parent": "600000",
    "group": "operating_expenses",
    "normal": "debit",
    "mapping": null,
    "header": true
  },
  {
    "code": "620001",
    "name": "Beban pembelian / jasa",
    "type": "expense",
    "parent": "620000",
    "group": "operating_expenses",
    "normal": "debit",
    "mapping": "PURCHASE_EXPENSE",
    "header": false
  },
  {
    "code": "620002",
    "name": "Beban sewa",
    "type": "expense",
    "parent": "620000",
    "group": "operating_expenses",
    "normal": "debit",
    "mapping": null,
    "header": false
  },
  {
    "code": "620003",
    "name": "Beban listrik",
    "type": "expense",
    "parent": "620000",
    "group": "operating_expenses",
    "normal": "debit",
    "mapping": null,
    "header": false
  },
  {
    "code": "620004",
    "name": "Beban internet",
    "type": "expense",
    "parent": "620000",
    "group": "operating_expenses",
    "normal": "debit",
    "mapping": null,
    "header": false
  },
  {
    "code": "620005",
    "name": "Beban penyusutan",
    "type": "expense",
    "parent": "620000",
    "group": "operating_expenses",
    "normal": "debit",
    "mapping": null,
    "header": false
  },
  {
    "code": "620006",
    "name": "Beban amortisasi",
    "type": "expense",
    "parent": "620000",
    "group": "operating_expenses",
    "normal": "debit",
    "mapping": null,
    "header": false
  },
  {
    "code": "630000",
    "name": "Beban pemasaran",
    "type": "expense",
    "parent": "600000",
    "group": "operating_expenses",
    "normal": "debit",
    "mapping": null,
    "header": true
  },
  {
    "code": "630001",
    "name": "Beban pemasaran",
    "type": "expense",
    "parent": "630000",
    "group": "operating_expenses",
    "normal": "debit",
    "mapping": null,
    "header": false
  },
  {
    "code": "640000",
    "name": "Biaya bank",
    "type": "expense",
    "parent": "600000",
    "group": "operating_expenses",
    "normal": "debit",
    "mapping": null,
    "header": true
  },
  {
    "code": "640001",
    "name": "Biaya administrasi bank / MDR",
    "type": "expense",
    "parent": "640000",
    "group": "operating_expenses",
    "normal": "debit",
    "mapping": "BANK_FEE",
    "header": false
  },
  {
    "code": "690000",
    "name": "Beban pajak penghasilan",
    "type": "expense",
    "parent": "600000",
    "group": "income_tax_expense",
    "normal": "debit",
    "mapping": null,
    "header": true
  },
  {
    "code": "690001",
    "name": "Beban pajak penghasilan",
    "type": "expense",
    "parent": "690000",
    "group": "income_tax_expense",
    "normal": "debit",
    "mapping": null,
    "header": false
  },
  {
    "code": "700000",
    "name": "Pendapatan lain",
    "type": "other_income",
    "parent": null,
    "group": null,
    "normal": "credit",
    "mapping": null,
    "header": true
  },
  {
    "code": "710000",
    "name": "Selisih kurs dan pendapatan keuangan",
    "type": "other_income",
    "parent": "700000",
    "group": "other_income",
    "normal": "credit",
    "mapping": null,
    "header": true
  },
  {
    "code": "710001",
    "name": "Laba selisih kurs",
    "type": "other_income",
    "parent": "710000",
    "group": "other_income",
    "normal": "credit",
    "mapping": "FX_GAIN",
    "header": false
  },
  {
    "code": "710002",
    "name": "Pendapatan bunga",
    "type": "other_income",
    "parent": "710000",
    "group": "other_income",
    "normal": "credit",
    "mapping": null,
    "header": false
  },
  {
    "code": "720000",
    "name": "Pendapatan lain-lain",
    "type": "other_income",
    "parent": "700000",
    "group": "other_income",
    "normal": "credit",
    "mapping": null,
    "header": true
  },
  {
    "code": "720001",
    "name": "Keuntungan penyesuaian stok",
    "type": "other_income",
    "parent": "720000",
    "group": "other_income",
    "normal": "credit",
    "mapping": "STOCK_GAIN",
    "header": false
  },
  {
    "code": "800000",
    "name": "Beban lain",
    "type": "other_expense",
    "parent": null,
    "group": null,
    "normal": "debit",
    "mapping": null,
    "header": true
  },
  {
    "code": "810000",
    "name": "Selisih kurs dan beban keuangan",
    "type": "other_expense",
    "parent": "800000",
    "group": "other_expenses",
    "normal": "debit",
    "mapping": null,
    "header": true
  },
  {
    "code": "810001",
    "name": "Rugi selisih kurs",
    "type": "other_expense",
    "parent": "810000",
    "group": "other_expenses",
    "normal": "debit",
    "mapping": "FX_LOSS",
    "header": false
  },
  {
    "code": "820000",
    "name": "Beban lain-lain",
    "type": "other_expense",
    "parent": "800000",
    "group": "other_expenses",
    "normal": "debit",
    "mapping": null,
    "header": true
  },
  {
    "code": "820001",
    "name": "Kerugian penyesuaian stok",
    "type": "other_expense",
    "parent": "820000",
    "group": "other_expenses",
    "normal": "debit",
    "mapping": "STOCK_LOSS",
    "header": false
  }
]
export const standardCoaVersion='FINORA-COA-2026.1'
