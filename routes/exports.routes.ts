import {Hono} from 'hono'
import type {AppBindings} from '../types/hono'
import {ReportExportService} from '../services/ReportExportService'
import {ok} from '../utils/response'
const route=new Hono<AppBindings>(),service=new ReportExportService()
route.get('/',async c=>ok(c,await service.list(c.get('user'))))
route.post('/',async c=>c.json({success:true,data:await service.create(c.get('user'),await c.req.json()),message:'Ekspor dijadwalkan'},202))
route.get('/:id',async c=>ok(c,await service.get(c.get('user'),c.req.param('id'))))
route.get('/:id/download',async c=>{
  const job=await service.get(c.get('user'),c.req.param('id'),true)
  return new Response(new Uint8Array(job.output),{headers:{'Content-Type':job.format==='pdf'?'application/pdf':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${job.filename}"`,'Cache-Control':'no-store'}})
})
export default route
