import type { MigrationDatabase } from './helpers'

type JournalNumberRow = {
  id: number
  company_id: number
  journal_number: string
  journal_date: string | Date
}

export const migration = {
  name: '024_flexible_numbering',
  async up(db: MigrationDatabase) {
    await db.query(`UPDATE number_sequences
      SET prefix = CASE
        WHEN prefix LIKE '%{MM}%' THEN prefix
        WHEN prefix LIKE '%{YYYY}%' THEN REPLACE(prefix, '{YYYY}', '{YYYY}-{MM}')
        WHEN prefix LIKE '%{YY}%' THEN REPLACE(prefix, '{YY}', '{YY}-{MM}')
        ELSE CONCAT(TRIM(TRAILING '-' FROM prefix), '-{YYYY}-{MM}-')
      END
      WHERE prefix NOT LIKE '%{MM}%'`)

    const [rows] = (await db.query(
      `SELECT id, company_id, journal_number, journal_date
       FROM journals ORDER BY company_id, journal_date, id`,
    )) as [JournalNumberRow[], unknown]

    const occupied = new Map<number, Set<string>>()
    for (const row of rows) {
      if (!occupied.has(row.company_id)) occupied.set(row.company_id, new Set())
      occupied.get(row.company_id)?.add(row.journal_number)
    }

    for (const row of rows) {
      const match = /^JV-(\d{4})-(\d+)$/.exec(row.journal_number)
      if (!match) continue
      const date = new Date(row.journal_date)
      const year = String(date.getUTCFullYear())
      const month = String(date.getUTCMonth() + 1).padStart(2, '0')
      const width = Math.max(6, match[2].length)
      let suffix = Number(match[2])
      let candidate = `JV-${year}-${month}-${String(suffix).padStart(width, '0')}`
      const companyNumbers = occupied.get(row.company_id) as Set<string>
      companyNumbers.delete(row.journal_number)
      while (companyNumbers.has(candidate)) {
        suffix += 1
        candidate = `JV-${year}-${month}-${String(suffix).padStart(width, '0')}`
      }
      await db.query(`UPDATE journals SET journal_number = '${candidate}' WHERE id = ${Number(row.id)}`)
      companyNumbers.add(candidate)
    }
  },
  async down() {
    // Nomor dokumen yang sudah dipakai tidak dikembalikan agar jejak audit tetap stabil.
  },
}
