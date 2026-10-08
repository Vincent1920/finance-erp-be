import {expect,test} from 'bun:test'
import {safeAlertMessage} from '../services/PlatformAlertService'
test('platform error messages omit credentials and quoted payload values',()=>{
 const message=safeAlertMessage('Bearer sensitive-token password=secret-value SQL \'private-data\'')
 expect(message).not.toContain('sensitive-token');expect(message).not.toContain('secret-value');expect(message).not.toContain('private-data')
 expect(safeAlertMessage('password="secret with spaces"')).not.toContain('with spaces')
 expect(safeAlertMessage('A'.repeat(2000)).length).toBe(1000)
})
