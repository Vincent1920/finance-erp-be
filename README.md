# Finance ERP API

Backend REST API terpisah untuk Finance ERP, menggunakan Bun, Hono, TypeScript, dan MySQL 8. Arsitektur aplikasi mengikuti Route → Middleware → Controller → Service → Repository → MySQL. Query selalu menggunakan parameter dan proses posting memakai satu database transaction.

## Requirement

- Bun 1.3+
- MySQL 8+
- Frontend pada `../finance-erp-web`

## Instalasi pertama

```bash
cd finance-erp-be
bun install
```

Salin `.env.example` menjadi `.env`, ganti JWT secret dan kredensial database. Buat database:

```sql
CREATE DATABASE finance_erp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Kemudian:

```bash
bun run migrate
bun run db:seed
bun run dev
```

API tersedia di `http://localhost:8000/api`; health check di `/api/health`. Frontend memakai `VITE_API_URL=http://localhost:8000/api`.

## Perintah

```bash
bun run typecheck
bun test
bun run migrate
bun run migrate:rollback
bun run db:seed
bun run db:reset       # development saja, menghapus seluruh tabel
```

## Login default

- Email: `admin@financeerp.local`
- Password: `password`

Segera ganti password default setelah login pertama. Seeder menyimpan password dalam hash bcrypt.

## Arsitektur

Alur request utama:

```text
Route → Middleware → Validator → Controller → Service → Repository → MySQL
```

- `routes`: pemetaan endpoint dan permission
- `middleware`: JWT, RBAC, request ID, CORS, logging, error
- `controllers`: menerjemahkan HTTP request/response
- `services`: aturan bisnis dan transaksi
- `repositories`: seluruh akses SQL
- `database`: migration runner, rollback, reset, seed
- `validators`: kontrak input Zod

## Database

Migration saat ini membangun core company/RBAC, master utama, jurnal, inventory balance/movement, sales invoice, dan purchase invoice. Semua tabel relevan memiliki `company_id`. Nilai uang memakai `DECIMAL(20,2)` dan kuantitas `DECIMAL(20,4)`.

Posted journal tidak dihapus. Posting jurnal mengunci record, memvalidasi periode, balance, dan status sebelum commit; kegagalan menyebabkan rollback.

## Code Style

Source TypeScript mengikuti Prettier dengan indentasi 2 spasi, single quote, tanpa semicolon,
trailing comma untuk multiline, dan lebar baris 100 karakter. Jalankan pemeriksaan sebelum commit:

```bash
bun run format
bun run format:check
bun run typecheck
bun test
```

## Development Flow

Perubahan dimulai dari validator dan route, lalu diteruskan ke controller, service, dan repository.
Business rule tetap berada di service; SQL dan persistence hanya berada di repository. Perubahan posting
akuntansi wajib mempertahankan transaction boundary, period lock, status guard, serta debit = credit.
