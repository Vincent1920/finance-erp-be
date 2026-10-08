import {expect,test} from 'bun:test'
import {base32,totp,verifyTotp} from '../utils/totp'
test('TOTP matches RFC 6238 SHA1 vectors and rejects replay',()=>{
 const secret=base32(Buffer.from('12345678901234567890'))
 expect(totp(secret,Math.floor(59/30),8)).toBe('94287082')
 expect(totp(secret,Math.floor(1111111109/30),8)).toBe('07081804')
 const code=totp(secret,100)
 expect(verifyTotp(secret,code,-1,100*30000)).toBe(100)
 expect(verifyTotp(secret,code,100,100*30000)).toBeNull()
 expect(verifyTotp(secret,'bad',-1,100*30000)).toBeNull()
})
