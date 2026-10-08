import { test, expect } from 'bun:test'
import { prepareDirectPosting } from '../services/WorkflowPolicyService'
test('workflow bypass only allows Draft with an explicit true company policy and writes audit', async () => {
  const calls: string[] = []
  const conn: any = { execute: async (sql: string) => { calls.push(sql); return sql.startsWith('SELECT') ? [[{setting_value:'true'}]] : [{affectedRows:1}] } }
  expect(await prepareDirectPosting(conn,1,'journals',2,'draft',3)).toBe(true)
  expect(calls.some(sql => sql.includes('audit_logs'))).toBe(true)
  calls.length = 0
  expect(await prepareDirectPosting(conn,1,'journals',2,'cancelled',3)).toBe(false)
  expect(calls.length).toBe(0)
  const disabled: any = {execute:async()=>[[]]}
  expect(await prepareDirectPosting(disabled,1,'journals',2,'draft',3)).toBe(false)
})
