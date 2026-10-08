import { PayrollAutomationService } from '../services/PayrollAutomationService'
import { PayrollComponentService } from '../services/PayrollComponentService'
import type { Context } from 'hono'
import { PayrollService } from '../services/PayrollService'
import { PayrollFileService } from '../services/PayrollFileService'
import { ValidationError } from '../utils/AppError'
import { ok, created } from '../utils/response'
import { operationContext } from './OperationsController'
import { positiveIdSchema } from '../validators/common.validator'
import {
  payrollProrationSchema,
  payrollRecurringSchema,
  payrollComponentSchema,
  payrollEmployeeSchema,
  payrollEmployeeStatusSchema,
  payrollEntryUpdateSchema,
  payrollPaymentSchema,
  payrollPeriodSchema,
  payrollPolicySchema,
  payrollPolicySimulationSchema,
  payrollReopenSchema,
  payrollRunSchema,
} from '../validators/payroll.validator'

export class PayrollController {
  constructor(
    private service = new PayrollService(),
    private files = new PayrollFileService(),
  ) {}
  recurringList=async(c:Context)=>ok(c,await new PayrollAutomationService().assignments(c.get('user').companyId))
  recurringCreate=async(c:Context)=>created(c,await new PayrollAutomationService().saveAssignment(c.get('user').companyId,null,payrollRecurringSchema.parse(await c.req.json()),operationContext(c)))
  recurringUpdate=async(c:Context)=>ok(c,await new PayrollAutomationService().saveAssignment(c.get('user').companyId,positiveIdSchema.parse(c.req.param('id')),payrollRecurringSchema.parse(await c.req.json()),operationContext(c)))
  recurringApply=async(c:Context)=>ok(c,await new PayrollAutomationService().applyRecurring(c.get('user').companyId,positiveIdSchema.parse(c.req.param('id')),operationContext(c)))
  proration=async(c:Context)=>ok(c,await new PayrollAutomationService().configureRun(c.get('user').companyId,positiveIdSchema.parse(c.req.param('id')),payrollProrationSchema.parse(await c.req.json()),operationContext(c)))
  attendanceTemplate=async(c:Context)=>this.download(c,new PayrollAutomationService().template(payrollPeriodSchema.parse(c.req.query('period'))))
  attendancePreview=async(c:Context)=>ok(c,await new PayrollAutomationService().preview(c.get('user').companyId,positiveIdSchema.parse(c.req.param('id')),await this.upload(c)))
  attendanceApply=async(c:Context)=>ok(c,await new PayrollAutomationService().apply(c.get('user').companyId,positiveIdSchema.parse(c.req.param('id')),await this.upload(c),operationContext(c)))
  componentList = async (c: Context) => ok(c,await new PayrollComponentService().list(c.get('user').companyId))
  componentCreate = async (c: Context) => created(c,await new PayrollComponentService().save(c.get('user').companyId,null,payrollComponentSchema.parse(await c.req.json()),operationContext(c)))
  componentUpdate = async (c: Context) => ok(c,await new PayrollComponentService().save(c.get('user').companyId,positiveIdSchema.parse(c.req.param('id')),payrollComponentSchema.parse(await c.req.json()),operationContext(c)))
  overview = async (c: Context) =>
    ok(
      c,
      await this.service.overview(
        c.get('user').companyId,
        payrollPeriodSchema.parse(c.req.query('period')),
      ),
    )
  employeeCreate = async (c: Context) =>
    created(
      c,
      await this.service.saveEmployee(
        c.get('user').companyId,
        null,
        payrollEmployeeSchema.parse(await c.req.json()),
        operationContext(c),
      ),
      'Pegawai berhasil ditambahkan',
    )
  employeeUpdate = async (c: Context) =>
    ok(
      c,
      await this.service.saveEmployee(
        c.get('user').companyId,
        positiveIdSchema.parse(c.req.param('id')),
        payrollEmployeeSchema.parse(await c.req.json()),
        operationContext(c),
      ),
      'Pegawai berhasil diperbarui',
    )
  employeeStatus = async (c: Context) => {
    const input = payrollEmployeeStatusSchema.parse(await c.req.json())
    return ok(
      c,
      await this.service.setEmployeeStatus(
        c.get('user').companyId,
        positiveIdSchema.parse(c.req.param('id')),
        input,
        operationContext(c),
      ),
      input.is_active ? 'Pegawai berhasil diaktifkan kembali' : 'Pegawai berhasil dinonaktifkan',
    )
  }
  employeeCompensationHistory = async (c: Context) =>
    ok(
      c,
      await this.service.compensationHistory(
        c.get('user').companyId,
        positiveIdSchema.parse(c.req.param('id')),
      ),
    )
  runCreate = async (c: Context) =>
    created(
      c,
      await this.service.createRun(
        c.get('user').companyId,
        payrollRunSchema.parse(await c.req.json()),
        operationContext(c),
      ),
      'Payroll berhasil dibuat',
    )
  detail = async (c: Context) =>
    ok(
      c,
      await this.service.detail(c.get('user').companyId, positiveIdSchema.parse(c.req.param('id'))),
    )
  entryUpdate = async (c: Context) =>
    ok(
      c,
      await this.service.updateEntry(
        c.get('user').companyId,
        positiveIdSchema.parse(c.req.param('id')),
        positiveIdSchema.parse(c.req.param('entryId')),
        payrollEntryUpdateSchema.parse(await c.req.json()),
        operationContext(c),
      ),
      'Komponen gaji diperbarui',
    )
  calculate = async (c: Context) =>
    ok(
      c,
      await this.service.calculate(
        c.get('user').companyId,
        positiveIdSchema.parse(c.req.param('id')),
      ),
      'Payroll berhasil dihitung',
    )
  reopen = async (c: Context) =>
    ok(
      c,
      await this.service.reopen(
        c.get('user').companyId,
        positiveIdSchema.parse(c.req.param('id')),
        payrollReopenSchema.parse(await c.req.json()).reason,
        operationContext(c),
      ),
      'Payroll dikembalikan ke Draft',
    )
  approve = async (c: Context) =>
    ok(
      c,
      await this.service.approve(
        c.get('user').companyId,
        positiveIdSchema.parse(c.req.param('id')),
        operationContext(c),
      ),
      'Payroll disetujui',
    )
  post = async (c: Context) =>
    ok(
      c,
      await this.service.post(
        c.get('user').companyId,
        positiveIdSchema.parse(c.req.param('id')),
        operationContext(c),
      ),
      'Jurnal payroll berhasil diposting',
    )
  pay = async (c: Context) => {
    const x = payrollPaymentSchema.parse(await c.req.json())
    return ok(
      c,
      await this.service.pay(
        c.get('user').companyId,
        positiveIdSchema.parse(c.req.param('id')),
        x.payment_account_id,
        x.payment_date,
        operationContext(c),
      ),
      'Pembayaran payroll berhasil diposting',
    )
  }
  unlock = async(c:Context)=>{const input=payrollReopenSchema.parse(await c.req.json());return ok(c,await this.service.unlock(c.get('user').companyId,positiveIdSchema.parse(c.req.param('id')),input.reason,operationContext(c)),'Kunci payroll dibuka; status kembali Sudah dibayar')}
  lock = async (c: Context) =>
    ok(
      c,
      await this.service.lock(
        c.get('user').companyId,
        positiveIdSchema.parse(c.req.param('id')),
        operationContext(c),
      ),
      'Payroll dikunci',
    )
  policy = async (c: Context) =>
    ok(
      c,
      await this.service.savePolicy(
        c.get('user').companyId,
        payrollPolicySchema.parse(await c.req.json()),
        operationContext(c),
      ),
      'Pengaturan payroll disimpan',
    )
  policySimulation = async (c: Context) =>
    ok(
      c,
      await this.service.simulatePolicy(
        c.get('user').companyId,
        positiveIdSchema.parse(c.req.param('id')),
        payrollPolicySimulationSchema.parse(await c.req.json()),
      ),
    )
  importPreview = async (c: Context) => {
    const file = await this.upload(c)
    return ok(
      c,
      await this.files.preview(
        c.get('user').companyId,
        positiveIdSchema.parse(c.req.param('id')),
        file,
      ),
    )
  }
  importApply = async (c: Context) => {
    const file = await this.upload(c)
    return ok(
      c,
      await this.files.apply(
        c.get('user').companyId,
        positiveIdSchema.parse(c.req.param('id')),
        file,
        operationContext(c),
      ),
      'Komponen payroll berhasil diimpor',
    )
  }
  importTemplate = async (c: Context) => this.download(c, this.files.template())
  export = async (c: Context) =>
    this.download(
      c,
      await this.files.export(
        c.get('user').companyId,
        positiveIdSchema.parse(c.req.param('id')),
        c.req.param('kind') ?? '',
      ),
    )
  private upload = async (c: Context) => {
    const body = await c.req.parseBody()
    const file = body.file
    if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function')
      throw new ValidationError('File CSV atau XLSX wajib dipilih')
    return file
  }
  private download(c: Context, result: { content: Buffer; contentType: string; filename: string }) {
    c.header('Content-Type', result.contentType)
    c.header('Content-Disposition', `attachment; filename="${result.filename}"`)
    c.header('Cache-Control', 'no-store')
    return c.body(new Uint8Array(result.content))
  }
}
