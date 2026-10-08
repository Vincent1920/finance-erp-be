import {describe,it,expect} from 'bun:test'
import {csvCell,csvFile,pdfFile,type FileSnapshot} from '../services/ReportFileService'
import {exportPermission,exportSchema} from '../services/ReportExportService'
import {inflateSync} from 'node:zlib'
const snapshot:FileSnapshot={title:'Buku Besar',company:'Perusahaan Uji',currency:'USD',period:'2026-01-01 - 2026-12-31',columns:[['reference','Referensi'],['amount','Nilai']],rows:[]}
describe('report export contract',()=>{
  it('keeps decimals numeric and prevents spreadsheet formula execution',()=>{
    expect(csvCell('-123.45')).toBe('-123.45')
    expect(csvCell('=HYPERLINK("url")')).toStartWith("'")
    expect(csvCell('one\ntwo')).toBe('one two')
    expect(csvFile({...snapshot,rows:[{reference:'invoice',amount:'120.50'}]}).toString()).toContain('invoice;120.50')
  })
  it('produces a direct multi-page PDF with repeated headers and page numbering',async()=>{
    const buffer=await pdfFile({...snapshot,rows:Array.from({length:1000},(_,i)=>({reference:`Invoice ${i+1}`,amount:'120.50'}))})
    expect(buffer.subarray(0,5).toString()).toBe('%PDF-')
    const text=buffer.toString('latin1')
    expect((text.match(/\/Type \/Page\b/g)||[]).length).toBeGreaterThan(20)
    expect(text).toContain('/Count')
    const decoded:string[]=[]
    const pattern=/stream\r?\n/g
    for(let match=pattern.exec(text);match;match=pattern.exec(text)){
      const start=match.index+match[0].length,end=text.indexOf('\nendstream',start)
      if(end<0)break
      try{const commands=inflateSync(buffer.subarray(start,end)).toString();decoded.push([...commands.matchAll(/<([0-9a-f]+)>/gi)].map(m=>Buffer.from(m[1]!,'hex').toString()).join(''))}catch{}
      pattern.lastIndex=end+10
    }
    const pages=(text.match(/\/Type \/Page\b/g)||[]).length
    expect((decoded.join('').match(/Buku Besar/g)||[]).length).toBe(pages)
    expect((decoded.join('').match(/Halaman /g)||[]).length).toBe(pages)
  })
  it('requires the permission belonging to the requested report',()=>{
    const user={id:1,companyId:1,name:'Uji',email:'uji@example.test',roles:[],permissions:['inventory.view']}
    expect(()=>exportPermission(user,'general_ledger')).toThrow()
    expect(()=>exportPermission(user,'stock_summary')).not.toThrow()
    expect(exportSchema.safeParse({report:'arbitrary_sql',format:'pdf',filters:{}}).success).toBe(false)
  })
})
