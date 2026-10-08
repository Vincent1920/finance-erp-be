import type { MigrationDatabase } from './helpers'
import {
  addCheckIfMissing,
  addIndexIfMissing,
  dropCheckIfExists,
  dropIndexIfExists,
} from './helpers'

export const migration = {
  name: '032_coa_hierarchy_foundation',
  async up(db: MigrationDatabase) {
    // Existing parents are authoritative: every account with children is a header.
    await db.query(`UPDATE accounts parent
      INNER JOIN (
        SELECT DISTINCT parent_id FROM accounts
        WHERE parent_id IS NOT NULL AND deleted_at IS NULL
      ) child ON child.parent_id = parent.id
      SET parent.is_header = TRUE, parent.is_posting = FALSE, parent.allow_manual_journal = FALSE
      `)
    await db.query(`UPDATE accounts
      SET is_header = FALSE, is_posting = TRUE
      WHERE is_header = is_posting
        AND NOT EXISTS (
          SELECT 1 FROM (SELECT parent_id FROM accounts WHERE deleted_at IS NULL) child
          WHERE child.parent_id = accounts.id
        )`)

    // Rebuild stored levels from the actual parent relationship.
    await db.query('UPDATE accounts SET level = 0')
    for (let depth = 1; depth <= 10; depth += 1)
      await db.query(`UPDATE accounts child
        INNER JOIN accounts parent ON parent.id = child.parent_id
        SET child.level = parent.level + 1
        WHERE child.parent_id IS NOT NULL AND child.level <= parent.level`)

    await addIndexIfMissing(
      db,
      'accounts',
      'idx_accounts_hierarchy',
      'INDEX idx_accounts_hierarchy(company_id,parent_id,code)',
    )
    await addCheckIfMissing(
      db,
      'accounts',
      'chk_accounts_single_role',
      '(is_header = TRUE AND is_posting = FALSE) OR (is_header = FALSE AND is_posting = TRUE)',
    )
    await addCheckIfMissing(db, 'accounts', 'chk_accounts_level', 'level BETWEEN 0 AND 10')
  },
  async down(db: MigrationDatabase) {
    await dropCheckIfExists(db, 'accounts', 'chk_accounts_level')
    await dropCheckIfExists(db, 'accounts', 'chk_accounts_single_role')
    await dropIndexIfExists(db, 'accounts', 'idx_accounts_hierarchy')
  },
}
