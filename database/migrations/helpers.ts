export type MigrationDatabase = {
  query: (sql: string) => Promise<unknown>
}

type CountRow = { object_count: number | string }

function identifier(value: string) {
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error(`Unsafe migration identifier: ${value}`)
  }

  return `\`${value}\``
}

function literal(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

async function hasObject(db: MigrationDatabase, sql: string) {
  const [rows] = (await db.query(sql)) as [CountRow[], unknown]
  return Number(rows[0]?.object_count ?? 0) > 0
}

export async function addColumnIfMissing(
  db: MigrationDatabase,
  table: string,
  column: string,
  definition: string,
) {
  const exists = await hasObject(
    db,
    `SELECT COUNT(*) AS object_count
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ${literal(table)}
        AND COLUMN_NAME = ${literal(column)}`,
  )

  if (!exists) {
    await db.query(
      `ALTER TABLE ${identifier(table)} ADD COLUMN ${identifier(column)} ${definition}`,
    )
  }
}

export async function addIndexIfMissing(
  db: MigrationDatabase,
  table: string,
  index: string,
  definition: string,
) {
  const exists = await hasObject(
    db,
    `SELECT COUNT(*) AS object_count
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ${literal(table)}
        AND INDEX_NAME = ${literal(index)}`,
  )

  if (!exists) {
    await db.query(`ALTER TABLE ${identifier(table)} ADD ${definition}`)
  }
}

export async function addForeignKeyIfMissing(
  db: MigrationDatabase,
  table: string,
  constraint: string,
  definition: string,
) {
  const exists = await hasObject(
    db,
    `SELECT COUNT(*) AS object_count
       FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE()
        AND TABLE_NAME = ${literal(table)}
        AND CONSTRAINT_NAME = ${literal(constraint)}
        AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
  )

  if (!exists) {
    await db.query(
      `ALTER TABLE ${identifier(table)} ADD CONSTRAINT ${identifier(constraint)} ${definition}`,
    )
  }
}

export async function dropColumnIfExists(
  db: MigrationDatabase,
  table: string,
  column: string,
) {
  const exists = await hasObject(
    db,
    `SELECT COUNT(*) AS object_count
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ${literal(table)}
        AND COLUMN_NAME = ${literal(column)}`,
  )

  if (exists) {
    await db.query(`ALTER TABLE ${identifier(table)} DROP COLUMN ${identifier(column)}`)
  }
}

export async function dropIndexIfExists(
  db: MigrationDatabase,
  table: string,
  index: string,
) {
  const exists = await hasObject(
    db,
    `SELECT COUNT(*) AS object_count
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ${literal(table)}
        AND INDEX_NAME = ${literal(index)}`,
  )

  if (exists) {
    await db.query(`ALTER TABLE ${identifier(table)} DROP INDEX ${identifier(index)}`)
  }
}

export async function dropForeignKeyIfExists(
  db: MigrationDatabase,
  table: string,
  constraint: string,
) {
  const exists = await hasObject(
    db,
    `SELECT COUNT(*) AS object_count
       FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE()
        AND TABLE_NAME = ${literal(table)}
        AND CONSTRAINT_NAME = ${literal(constraint)}
        AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
  )

  if (exists) {
    await db.query(
      `ALTER TABLE ${identifier(table)} DROP FOREIGN KEY ${identifier(constraint)}`,
    )
  }
}

export async function dropTables(db: MigrationDatabase, tables: readonly string[]) {
  for (const table of tables) {
    await db.query(`DROP TABLE IF EXISTS ${identifier(table)}`)
  }
}
