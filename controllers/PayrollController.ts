import type { Context } from 'hono'
import { PayrollService } from '../services/PayrollService'
import { ok, created } from '../utils/response'
import { operationContext } from './OperationsController'
import { positiveIdSchema } from '../validators/common.validator'
import { payrollEmployeeSchema, payrollEntryUpdateSchema, payrollPaymentSchema, payrollPeriodSchema, payrollPolicySchema, payrollReopenSchema, payrollRunSchema } from '../validators/payroll.validator'

export class PayrollController {
  constructor(private service = new PayrollService()) {}
  overview = async (c: Context) => ok(c, await this.service.overview(c.get('user').companyId, payrollPeriodSchema.parse(c.req.query('period'))))
  employeeCreate = async (c: Context) => created(c, await this.service.saveEmployee(c.get('user').companyId,null,payrollEmployeeSchema.parse(await c.req.json()),operationContext(c)),'Pegawai berhasil ditambahkan')
  employeeUpdate = async (c: Context) => ok(c, await this.service.saveEmployee(c.get('user').companyId,positiveIdSchema.parse(c.req.param('id')),payrollEmployeeSchema.parse(await c.req.json()),operationContext(c)),'Pegawai berhasil diperbarui')
  runCreate = async (c: Context) => created(c, await this.service.createRun(c.get('user').companyId,payrollRunSchema.parse(await c.req.json()),operationContext(c)),'Payroll berhasil dibuat')
  detail = async (c: Context) => ok(c, await this.service.detail(c.get('user').companyId,positiveIdSchema.parse(c.req.param('id'))))
  entryUpdate = async (c: Context) => ok(c, await this.service.updateEntry(c.get('user').companyId,positiveIdSchema.parse(c.req.param('id')),positiveIdSchema.parse(c.req.param('entryId')),payrollEntryUpdateSchema.parse(await c.req.json())),'Komponen gaji diperbarui')
  calculate = async (c: Context) => ok(c, await this.service.calculate(c.get('user').companyId,positiveIdSchema.parse(c.req.param('id'))),'Payroll berhasil dihitung')
  reopen = async (c: Context) => ok(c, await this.service.reopen(c.get('user').companyId,positiveIdSchema.parse(c.req.param('id')),payrollReopenSchema.parse(await c.req.json()).reason,operationContext(c)),'Payroll dikembalikan ke Draft')
  approve = async (c: Context) => ok(c, await this.service.approve(c.get('user').companyId,positiveIdSchema.parse(c.req.param('id')),operationContext(c)),'Payroll disetujui')
  post = async (c: Context) => ok(c, await this.service.post(c.get('user').companyId,positiveIdSchema.parse(c.req.param('id')),operationContext(c)),'Jurnal payroll berhasil diposting')
  pay = async (c: Context) => { const x=payrollPaymentSchema.parse(await c.req.json()); return ok(c,await this.service.pay(c.get('user').companyId,positiveIdSchema.parse(c.req.param('id')),x.payment_account_id,x.payment_date,operationContext(c)),'Pembayaran payroll berhasil diposting') }
  lock = async (c: Context) => ok(c,await this.service.lock(c.get('user').companyId,positiveIdSchema.parse(c.req.param('id')),operationContext(c)),'Payroll dikunci')
  policy = async (c: Context) => ok(c,await this.service.savePolicy(c.get('user').companyId,payrollPolicySchema.parse(await c.req.json()),operationContext(c)),'Pengaturan payroll disimpan')
}
