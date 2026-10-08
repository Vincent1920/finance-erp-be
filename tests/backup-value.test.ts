import {expect,test} from 'bun:test'
import {restoreDatabaseValue} from '../services/BackupService'
test('restore converts database timestamps and binary data without changing text dates',()=>{
 const date='2026-10-08T01:02:03.456Z'
 expect((restoreDatabaseValue(date,'datetime') as Date).toISOString()).toBe(date)
 expect(restoreDatabaseValue(date,'text')).toBe(date)
 expect(Buffer.isBuffer(restoreDatabaseValue({type:'Buffer',data:[37,80,68,70]},'longblob'))).toBe(true)
 expect(restoreDatabaseValue({foo:1},'json')).toBe('{"foo":1}')
 expect(restoreDatabaseValue(null,'datetime')).toBeNull()
})
