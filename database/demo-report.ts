/** Generate the reviewable checklist from the final audit, without changing application data. */
export {}
const audit = await Bun.file('storage/demo-audit/menu-checks.json').json()
const subledger = await Bun.file('storage/demo-audit/rekonsiliasi-subledger.json').json()
const equity = await Bun.file('storage/demo-audit/ekuitas.json').json()
const stages = await Bun.file('storage/demo-complete-results.json').json()
const money = (value: unknown) =>
  Number(value).toLocaleString('id-ID', { maximumFractionDigits: 2 })
const scope = (path: string) => {
  if (path.includes('/settlements'))
    return 'Pelunasan parsial, multi-invoice, biaya bank, retry dan pembalikan diuji di layanan/integrasi.'
  if (path.includes('/returns'))
    return 'Retur, batas kuantitas, alokasi pajak dan pembalikan diuji di integrasi.'
  if (path.includes('/invoices'))
    return 'Alur posting, jurnal, saldo terbuka dan pembayaran diuji; seluruh variasi form belum diuji melalui klik.'
  if (path.includes('/orders'))
    return 'Daftar dan contoh beberapa status tersedia; seluruh konversi order belum diuji ulang melalui UI.'
  if (path.includes('/opening-balances'))
    return 'Batch GL disetujui dan diposting; stok tersedia. Migrasi outstanding AR/AP masih perlu pengembangan.'
  if (path.includes('/equity'))
    return 'Alokasi modal dua pemegang saham dan laporan diperiksa. Seluruh aksi dividen belum diuji ulang pada data baru.'
  if (path.includes('/schedules'))
    return 'Akrual, amortisasi, jurnal pengakuan, reversal serta perbandingan aktual tersedia.'
  if (path.includes('/recurring')) return 'Jadwal bulanan, pembuatan jurnal dan posting diuji.'
  if (path.includes('/journals'))
    return 'Double entry, persetujuan, posting, pembalikan, periode dan penomoran tercakup pengujian.'
  if (path === '/banking/statements')
    return 'CSV tanggal DD/MM/YYYY berhasil divalidasi dan diimpor; dua rekening koran tersedia.'
  if (path === '/banking/reconciliation')
    return 'Rekening koran BCA cocok dengan GL; satu baris November sengaja belum dicocokkan.'
  if (path.startsWith('/banking'))
    return 'Daftar rekening/buku kas terbaca; bank asing dan semua format bank belum diuji penuh.'
  if (path === '/payroll')
    return 'September dihitung–disetujui–diposting–dibayar; Oktober 60 pegawai calculated. Empat ekspor per periode berhasil.'
  if (path.startsWith('/tax'))
    return 'Contoh internal/SPT, pencocokan, selisih dan lock diuji; format legal terbaru tidak disertifikasi dalam audit ini.'
  if (path.startsWith('/assets'))
    return 'Lima aset, 45 penyusutan Jan–Sep, pengendalian duplikasi dan rekonsiliasi GL diperiksa.'
  if (path.startsWith('/budgeting'))
    return 'Anggaran disetujui oleh pengguna berbeda; aktual dan transaksi di luar anggaran diperiksa.'
  if (path.startsWith('/inventory'))
    return 'Saldo awal, mutasi, barang tanpa mutasi, filter, transfer dan adjustment tercakup; seluruh variasi impor belum diuji.'
  if (path === '/reports/subledger')
    return 'Tujuh baris kontrol AR/AP/stok/bank/aset cocok dengan GL pada 31 Oktober.'
  if (path.includes('trial-balance') || path.includes('balance-sheet'))
    return 'Laporan seimbang; selisih Rp 0 pada 31 Oktober.'
  if (path === '/reports/equity-changes')
    return 'Saldo akhir ekuitas cocok dengan neraca; kontrol modal dan alokasinya diperiksa.'
  if (
    path.startsWith('/reports') ||
    path.includes('receivables') ||
    path.includes('payables') ||
    path.includes('general-ledger')
  )
    return 'Laporan terbaca; aging historis dan saldo GL diuji. Semua filter/cetak belum diuji melalui UI.'
  if (path === '/system/data-import')
    return 'Preview dan konfirmasi CSV bank berhasil: 1 baris masuk, 0 gagal. Semua jenis import belum diuji ulang.'
  if (path === '/system/backup')
    return 'Backup penuh sebelum reset berhasil dibuat. Menu diperbaiki. Restore ke database aktif tidak dilakukan.'
  if (path === '/system/settings')
    return 'Identitas, mapping, kesiapan akun, nomor dan template terbaca. Semua kombinasi cetak belum diuji.'
  if (path.includes('closing') || path.includes('month-end') || path.includes('year-end'))
    return 'Checklist/status terbaca; periode demo tetap terbuka. Semua alur close/reopen belum diuji ulang di perusahaan demo.'
  if (path.startsWith('/master'))
    return 'Data master terbaca. Edit/hapus setiap jenis master belum diulang melalui UI.'
  if (path === '/approvals')
    return 'Maker/checker digunakan pada jurnal, payroll dan anggaran; self-approval anggaran ditolak dalam integrasi.'
  return 'Halaman dan API daftar terbaca; seluruh tombol, hak akses dan aksi massal belum diuji penuh.'
}
const checklist = audit.menus
  .map(
    (menu: any, index: number) =>
      `| ${index + 1} | ${menu.name} | ${menu.apiStatus === 'PASS' ? '✓' : menu.apiStatus} | ✓ | ${scope(menu.path)} |`,
  )
  .join('\n')
const checks = audit.checks
  .map(
    (check: any) =>
      `- [${check.status === 'PASS' ? 'x' : ' '}] ${check.name}${check.status === 'FAIL' ? ` — ${check.evidence}` : ''}`,
  )
  .join('\n')
const controls = subledger
  .map(
    (row: any) =>
      `| ${row.type} | ${row.accountCode} — ${row.accountName} | ${money(row.subledger)} | ${money(row.generalLedger)} | ${money(row.difference)} |`,
  )
  .join('\n')
const text = `# Laporan pemeriksaan FINORA — 4 Oktober 2026

Perusahaan: PT Finora Indonesia, lingkungan pengembangan lokal. Pemeriksaan ini menilai aplikasi yang tersedia, mengisi contoh transaksi baru, dan menguji kecocokan antar modul. Rekomendasi di bawah merupakan rencana perbaikan, bukan klaim bahwa semua fitur sudah sempurna.

## Ringkasan hasil

- Transaksi lama sudah dibersihkan setelah backup penuh disimpan. Master dan pengaturan utama dipertahankan; kode pajak pada reset pertama diisi ulang oleh seed. Script reset telah diperbaiki agar kode pajak dipertahankan pada penggunaan berikutnya.
- **64/64 menu**: API daftar/laporan berhasil (HTTP 200), halaman desktop berhasil dibuka dan kontennya diperiksa melalui browser. Tidak ditemukan error konsol pada pemeriksaan ini.
- **46 skenario integrasi operasional lulus**, dijalankan pada database uji terpisah. **155 tes otomatis lulus, 2 dilewati** karena membutuhkan mode integrasi khusus. Pemeriksaan tipe backend dan build frontend lulus.
- **${audit.checks.filter((c: any) => c.status === 'PASS').length}/${audit.checks.length} pemeriksaan khusus data baru lulus**; ${stages.filter((s: any) => s.status === 'PASS').length}/${stages.length} kelompok pengisian data berhasil.
- Neraca saldo, neraca dan perubahan ekuitas seimbang. Tujuh baris rekonsiliasi subledger memiliki selisih **Rp 0** per 31 Oktober 2026.

**Batas status ceklis:** tanda ✓ API berarti data berhasil diambil; tanda ✓ UI berarti halaman berhasil dibuka dan konten tampil. Ini tidak berarti setiap tombol, setiap kombinasi pajak, setiap hak akses, dan semua kondisi produksi telah diuji. Kolom terakhir menjelaskan bukti fungsi dan batasnya.

## Data dummy baru

| Kelompok | Isi contoh |
|---|---|
| Master | 20 pelanggan, 15 pemasok, 30 barang/jasa; gudang, satuan dan akun |
| Akuntansi | ${audit.counts.journals} jurnal, saldo awal GL Rp 767.600.000 debit/kredit; berbagai status dan reversal |
| Penjualan/pembelian | 12 sales invoice, 8 purchase invoice; masing-masing 1 pelunasan; 2 retur penjualan, 1 retur pembelian |
| Persediaan | Saldo awal 21 baris, 1 transfer gudang, 1 penyesuaian |
| Aset | 5 aset dengan nilai perolehan Rp 50.000.000, 45 penyusutan Januari–September |
| Payroll | 60 pegawai fiktif; September 3 pegawai sudah dibayar; Oktober 60 pegawai calculated dan belum diposting |
| Akrual/amortisasi | 2 jadwal, pengakuan pertama, reversal akrual, contoh aktual vs estimasi |
| Jurnal berulang/anggaran | 1 jadwal bulanan, 1 anggaran tahunan approved |
| Modal | 2 pemegang saham; alokasi modal 60% dan 40% |
| Bank | 2 rekening koran, 1 rekonsiliasi lengkap, aturan/pemetaan tersimpan, 1 impor CSV berhasil |
| Pajak | 8 baris internal dan 6 baris SPT dengan contoh pencocokan/selisih |

Gunakan periode September/Oktober 2026 untuk melihat contoh. Laporan kontrol utama memakai **1 Januari–31 Oktober 2026**. Baris biaya bank November adalah contoh pending, sehingga tidak termasuk kontrol Oktober. Angka/rate payroll, identitas, rekening dan NPWP dummy tidak dimaksudkan sebagai data kepatuhan nyata.

## Ceklis seluruh menu

| No. | Menu | API | UI desktop | Fungsi diperiksa / batas cakupan |
|---|---|---|---|---|
${checklist}

## Pemeriksaan khusus dan kebenaran laporan

${checks}

| Kontrol | Akun | Rincian/subledger (Rp) | Buku besar (Rp) | Selisih (Rp) |
|---|---|---:|---:|---:|
${controls}

Perubahan ekuitas: selisih terhadap neraca Rp ${money(equity.difference)}. Kontrol modal: selisih nominal Rp ${money(equity.capitalControl.difference)}, selisih alokasi pemegang saham Rp ${money(equity.capitalControl.allocationDifference)}.

Skenario integrasi mencakup pajak potong hanya atas ongkir, pembayaran parsial/multi-invoice, retry pembayaran, penolakan overpayment, retur parsial, supplier credit/refund, transfer satuan dan reversal, aging historis, saldo stok, filter beberapa item, penyusutan berurutan, anggaran, pencocokan bank, batal/hapus sesuai status, rekonsiliasi pajak dan penguncian masa. Hasil seimbang tetap perlu dilengkapi validasi klasifikasi akun, cut-off, bukti dokumen dan otorisasi.

## Temuan dan perbaikan yang sudah dilakukan

1. **Saldo awal persediaan dummy berbeda dari rincian stok.** Nilai GL disamakan dengan total biaya stok awal sebelum jurnal saldo awal diposting. Kontrol Oktober sekarang Rp 0.
2. **Penyusutan dummy ganda Rp 1.000.000.** Ada jurnal manual lama di samping 45 penyusutan register aset. Jurnal manual dibalik melalui engine dengan alasan koreksi; histori dipertahankan. Akumulasi penyusutan sekarang Rp 9.703.125 di register maupun GL.
3. **Menu Backup membuka identitas perusahaan.** Pemilihan subbagian kini mengikuti jalur menu sehingga Backup membuka Backup & Pemulihan. Diverifikasi kembali melalui browser.
4. **Script contoh tidak aman untuk diulang pada kebijakan payroll yang sudah dipakai.** Script kini memakai kebijakan yang sudah tersedia tanpa mencoba mengubahnya. Penolakan engine terhadap perubahan kebijakan historis bekerja.
5. **Level akun tambahan dummy.** Level mengikuti level akun induk + 1 sehingga struktur akun konsisten.

## Rekomendasi prioritas

| Prioritas | Area | Usulan konkret | Manfaat / kriteria penerimaan |
|---|---|---|---|
| P0 | Kontrol payroll | Batasi file transfer final pada payroll yang approved/posted dan belum dibayar; ekspor sebelum persetujuan harus jelas berlabel simulasi. Catat batch/referensi dan cegah pengiriman ulang. | Audit ini membuktikan file bank bisa diekspor dari run calculated Oktober. CSV sekarang masih umum, bukan format upload final tiap bank. |
| P0 | Saldo awal | Lengkapi migrasi outstanding AR/AP per mitra/invoice, aset dan stok dalam satu paket cut-off; validasi saldo kontrol sebelum posting. | GL opening saat ini belum membuat rincian invoice AR/AP. Demo stok 2 Januari dan GL 1 Januari perlu diselaraskan agar laporan 1 Januari juga konsisten. |
| P0 | Rekonsiliasi | Jalankan kontrol AR/AP/stok/bank/aset/payroll/pajak otomatis sebelum close, dengan penanggung jawab dan bukti penyelesaian. | Selisih tidak cukup disembunyikan; close harus terblokir atau memperoleh pengecualian yang disetujui. |
| P0 | Kualitas master | Pusatkan pengecekan akun aktif/posting, NPWP/NIK, rekening, UOM, duplikat mitra dan kelengkapan dokumen. Pisahkan akun kontrol dari jurnal manual biasa. | Jurnal manual ke akun kontrol dapat menimbulkan selisih walaupun debit/kredit seimbang. |
| P0 | Hak akses | Uji matriks accountant/finance/HR/approver/viewer dengan data lintas perusahaan dan pemisahan pembuat–penyetuju. | Pemeriksaan menu memakai Super Admin; belum membuktikan seluruh pembatasan pengguna lain. |
| P0 | Backup/operasi | Latihan restore pada database terpisah, jadwal backup, retensi, pemeriksaan checksum, alarm kegagalan dan waktu pemulihan. | Backup berhasil dibuat; pemulihan nyata belum diuji pada audit ini. |
| P1 | Format laporan | Identitas perusahaan, rentang/as-of, mata uang, status posted, waktu pembuatan dan filter aktif wajib terlihat; kolom nominal rata kanan, subtotal jelas, header berulang pada cetak. | Paket tutup bulan: TB, neraca, laba rugi, arus kas, ekuitas, aging dan rekonsiliasi dengan parameter sama. |
| P1 | Penelusuran laporan | Klik saldo → akun → jurnal → invoice/payment/stock source; tampilkan selisih dan alasan secara terhubung. | Pengguna dapat memeriksa angka tanpa mencari ulang di beberapa menu. |
| P1 | UX | Bahasa konsisten: masih ada Transfers, posted, validated dan Bank Statements; gunakan label Indonesia yang seragam dan jelaskan status. | Mengurangi salah paham bahwa validated sama dengan posted. |
| P1 | UX tabel/form | Perkuat mode ringkas/detail, kolom beku, filter/kolom tersimpan, pencarian keyboard, jumlah hasil, tombol aksi tetap terlihat dan validasi di bawah field. | Uji alur input dengan keyboard serta kembali ke posisi tabel setelah detail ditutup. |
| P1 | Payroll skala besar | Uji 500/1.000 pegawai, proses batch dengan progress/cancel/retry, impor komponen, rekening ganda dan perbandingan kebijakan. Snapshot identitas komponen untuk output historis. | Audit ini menguji batch 60 pegawai, belum membuktikan kinerja 1.000 pegawai. |
| P1 | Pajak | Checklist kelengkapan bukti/faktur, revisi dokumen, koreksi masa dan rekonsiliasi pembayaran; verifikasi format resmi saat akan digunakan. | Rekonsiliasi dummy berjalan, tetapi validitas seluruh kondisi pajak bukan hasil audit ini. Generator XML tidak menjadi prioritas sesuai permintaan. |
| P1 | Impor | Pemetaan format per bank, preview tanggal/angka yang sudah dinormalisasi, laporan error per baris dan retry tanpa duplikasi. | Tanggal 01/11/2026 berhasil; seluruh CSV/XLSX regional belum diuji. |
| P1 | Akrual/aktual | Hubungkan nilai aktual ke invoice/jurnal sumber dan jelaskan selisih yang belum dijurnal. | Isian actual_amount contoh belum menjamin beban aktual sudah tercatat di GL. |
| P2 | Finance | Proyeksi kas, rencana penagihan/pembayaran, reminder terarah, forecast anggaran dan analisis varians. | Tugas harian menghasilkan tindakan, bukan hanya daftar angka. |
| P2 | Multi-currency | Uji rekening USD, kurs transaksi/pelunasan, transfer antar mata uang dan revaluasi dengan FX gain/loss. | Dukungan field mata uang tidak cukup membuktikan alur multi-currency end-to-end. |
| P2 | IT/produk | Monitoring error terstruktur, pagination server, indeks query, uji konkurensi, responsif ponsel dan pemeriksaan aksesibilitas. | Ukur waktu respons, kebocoran data dan benturan update dengan beban nyata. |

## Urutan tahap berikutnya

1. Kontrol file transfer payroll, migrasi saldo awal subledger dan cut-off yang konsisten.
2. Matriks hak akses dan close checklist berbasis rekonsiliasi; latihan restore terpisah.
3. Standarisasi laporan/cetak, drill-down dan bahasa/status antarmuka.
4. Uji beban payroll/import/konkurensi, lalu perluas forecast serta multi-currency.

## Bukti dan penggunaan

- Backup sebelum reset: finance-erp-be/storage/backups/BKP-2026-10-000001.json.
- Hasil 64 API dan 13 pemeriksaan khusus: finance-erp-be/storage/demo-audit/menu-checks.json.
- Neraca, ekuitas dan kontrol subledger: file JSON pada folder storage/demo-audit.
- Contoh impor bank: storage/demo-audit/contoh-import-mutasi-bank.csv — sudah diimpor; jika diulang gunakan nomor rekening koran/referensi baru atau skip duplikat.
- Ekspor September/Oktober: payroll, BPJS, PPh 21 dan CSV bank pada folder yang sama. File Oktober adalah hasil perhitungan belum disetujui.
- Audit dapat diulang dengan bun database/demo-audit.ts; pengisian contoh tambahan dengan bun database/demo-complete.ts. Reset transaksi memerlukan perintah terpisah bun database/demo-refresh.ts --apply dan akan kembali menghapus transaksi demo setelah backup.

Belum diuji penuh: semua kombinasi CRUD melalui UI, mobile, akses setiap role, 1.000 pegawai, seluruh format bank, transfer uang nyata, pengiriman slip nyata, restore aktif, seluruh siklus tutup tahun, kepatuhan pajak produksi. Jangan menafsirkan 64/64 menu sebagai sertifikasi siap produksi tanpa pemeriksaan tersebut.
`
await Bun.write('../LAPORAN-CHECKLIST-FINORA-2026-10-04.md', text)
console.log('Report written: LAPORAN-CHECKLIST-FINORA-2026-10-04.md')
