import {expect,test} from 'bun:test'
import {standardCoa} from '../constants/standard-coa'
import {accountMappingDefinitions} from '../services/AccountMappingService'
test('standard COA covers engine mappings with compatible account types',()=>{
 const mapped=standardCoa.filter(r=>r.mapping)
 expect(new Set(mapped.map(r=>r.mapping)).size).toBe(Object.keys(accountMappingDefinitions).length)
 for(const row of mapped){expect((accountMappingDefinitions[row.mapping!].types as readonly string[]).includes(row.type)).toBe(true);expect(row.header).toBe(false)}
})
test('standard COA puts liquid current assets before non-current and pairs contra assets',()=>{
 const code=(mapping:string)=>Number(standardCoa.find(r=>r.mapping===mapping)!.code)
 expect(code('CASH')).toBeLessThan(code('BANK'));expect(code('BANK')).toBeLessThan(code('AR_CONTROL'));expect(code('AR_CONTROL')).toBeLessThan(code('INVENTORY'))
 expect(code('INVENTORY')).toBeLessThan(Number(standardCoa.find(r=>r.name==='Biaya dibayar di muka'&&!r.header)!.code))
 expect(standardCoa.find(r=>r.code==='121103')!.normal).toBe('credit')
 expect(standardCoa.find(r=>r.code==='121103')!.group).toBe(standardCoa.find(r=>r.code==='121003')!.group)
 expect(code('FX_GAIN')).toBeGreaterThan(700000);expect(code('FX_LOSS')).toBeGreaterThan(800000)
})
test('standard COA parent hierarchy is unique, ordered and header-only',()=>{
 expect(new Set(standardCoa.map(r=>r.code)).size).toBe(standardCoa.length)
 for(const row of standardCoa){expect(row.code).toMatch(/^[1-8][0-9]{5}$/);if(row.parent){const parent=standardCoa.find(r=>r.code===row.parent)!;expect(parent.header).toBe(true);expect(Number(parent.code)).toBeLessThan(Number(row.code));expect(parent.type).toBe(row.type)}}
})
