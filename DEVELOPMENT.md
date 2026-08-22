# Panduan Pengembangan

## Menjalankan Project

```bash
bun install
bun run migrate
bun run db:seed
bun run dev
bun test
bun run format
bun run format:check
```

## Migration

Tambahkan file bernomor pada `database/migrations`, ekspor objek `{ name, up, down }`, lalu daftarkan di `database/migrations/index.ts`.

```bash
bun run migrate
bun run migrate:rollback
```

Ekuivalen `php artisan migrate:fresh --seed` untuk development:

```bash
bun run db:reset
bun run migrate
bun run db:seed
```

`db:reset` menolak berjalan jika `APP_ENV` bukan `development`.

## Endpoint baru

1. Buat validator Zod.
2. Buat repository dengan parameterized query (`?`).
3. Taruh aturan bisnis dan transaction boundary di service.
4. Buat controller tanpa SQL.
5. Daftarkan route, JWT middleware, dan permission.
6. Tambahkan test dan request Postman.

Jangan mengakses database dari route/controller. Semua posting accounting dipusatkan di `PostingService`.

## Seed dan inspeksi MySQL

Ubah `database/seed.ts`, lalu jalankan `bun run db:seed`. Inspeksi melalui:

```bash
mysql -u root -p finance_erp
SHOW TABLES;
SELECT * FROM migrations ORDER BY id;
```

## Debug API

Jalankan `bun run dev`, lihat request ID pada header `X-Request-Id`, lalu gunakan request ID itu untuk mencocokkan log. Detail internal hanya dikirim saat development. Uji health endpoint sebelum mendiagnosis endpoint bisnis.
