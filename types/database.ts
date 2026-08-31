import type { PoolConnection } from 'mysql2/promise'

export type QueryExecutor = Pick<PoolConnection, 'execute' | 'query'>

export type DatabaseValue = string | number | boolean | Date | null
