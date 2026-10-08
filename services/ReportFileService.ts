import PDFDocument from 'pdfkit'
import { stringify } from 'csv-stringify/sync'
export type FileSnapshot = { title: string; company: string; currency: string; period: string; columns: [string,string][]; rows: Record<string,unknown>[] }
// Spreadsheet formula prefixes are escaped only for text; decimal amounts stay numeric.
export function csvCell(value: unknown) {
  const text = String(value ?? '').replace(/[\r\n]+/g,' ')
  if (/^-?\d+(\.\d+)?$/.test(text)) return text
  return /^[=+\-@\t]/.test(text) ? `'${text}` : text
}
export function csvFile(snapshot: FileSnapshot) {
  return Buffer.from('\uFEFF' + stringify([snapshot.columns.map(c=>c[1]), ...snapshot.rows.map(r=>snapshot.columns.map(c=>csvCell(r[c[0]])))], {delimiter:';', record_delimiter:'\r\n'}))
}
export function pdfFile(snapshot: FileSnapshot): Promise<Buffer> {
  return new Promise((resolve,reject)=>{
    const doc = new PDFDocument({size:'A4',layout:'landscape',margin:32,bufferPages:true})
    const chunks: Buffer[]=[]
    doc.on('data',chunk=>chunks.push(chunk)); doc.on('end',()=>resolve(Buffer.concat(chunks))); doc.on('error',reject)
    const width=doc.page.width-64, columnWidth=width/snapshot.columns.length
    let y=32
    const header=()=>{
      doc.font('Helvetica-Bold').fontSize(13).text(snapshot.title,32,32)
      doc.font('Helvetica').fontSize(8).text(`${snapshot.company} | ${snapshot.period} | ${snapshot.currency} | ${snapshot.rows.length} baris`,32,52)
      y=76
      doc.font('Helvetica-Bold').fontSize(7)
      let height=24
      for(const [,label] of snapshot.columns) height=Math.max(height,doc.heightOfString(label,{width:columnWidth-8})+10)
      snapshot.columns.forEach(([,label],i)=>doc.text(label,36+i*columnWidth,y+4,{width:columnWidth-8}))
      y+=height; doc.moveTo(32,y).lineTo(32+width,y).strokeColor('#94a3b8').stroke()
    }
    header()
    for(const row of snapshot.rows){
      doc.font('Helvetica').fontSize(7)
      const values=snapshot.columns.map(([key])=>String(row[key]??'').replace(/[\r\n]+/g,' '))
      const height=Math.max(20,...values.map(v=>doc.heightOfString(v,{width:columnWidth-8})+10))
      if(height>doc.page.height-150) {doc.destroy(); reject(new Error('Satu baris terlalu panjang untuk PDF; gunakan CSV.'));return}
      if(y+height>doc.page.height-42){doc.addPage();header();doc.font('Helvetica').fontSize(7)}
      values.forEach((v,i)=>doc.text(v,36+i*columnWidth,y+5,{width:columnWidth-8}))
      y+=height;doc.moveTo(32,y).lineTo(32+width,y).strokeColor('#e2e8f0').stroke()
    }
    const range=doc.bufferedPageRange()
    for(let i=range.start;i<range.start+range.count;i++){
      doc.switchToPage(i);doc.font('Helvetica').fontSize(7).text(`Halaman ${i+1} / ${range.count}`,32,doc.page.height-28,{lineBreak:false})
    }
    doc.end()
  })
}
