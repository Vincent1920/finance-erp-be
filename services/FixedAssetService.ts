import { accountingPolicy } from './AccountingPolicyService'
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import { db } from '../config/database'
import { BusinessValidationService } from './BusinessValidationService'
import { PostingService, type PostingContext } from './PostingService'
import { AuditService } from './AuditService'
import { idempotentOperation } from './IdempotentOperation'
import {
  compareDecimal,
  subtractDecimal,
  addDecimal,
  toScaledInteger,
  fromScaledInteger,
} from '../utils/decimal'
import { ConflictError, NotFoundError, ValidationError } from '../utils/AppError'
import type { AssetInput, ReversalInput } from '../validators/operations.validator'
export function depreciationTarget(cost: string, salvage: string, life: number, months: number, method = 'straight_line') {
  if(method==='declining_balance'){
    const total=toScaledInteger(cost)-toScaledInteger(salvage); let remaining=total; const n=Math.max(0,Math.min(life,months));
    for(let i=0;i<n;i++){ const straight=(remaining+BigInt(Math.floor((life-i)/2)))/BigInt(life-i); const declining=((remaining+toScaledInteger(salvage))*2n+BigInt(Math.floor(life/2)))/BigInt(life); remaining-=declining>straight?(declining>remaining?remaining:declining):straight; }
    return fromScaledInteger(total-remaining)
  }
  const depreciable = toScaledInteger(cost) - toScaledInteger(salvage)
  const elapsed = BigInt(Math.max(0, Math.min(life, months)))
  return fromScaledInteger((depreciable * elapsed + BigInt(Math.floor(life / 2))) / BigInt(life))
}
const dateOnly = (v: unknown) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)
export class FixedAssetService {
  async history(companyId: number, assetId: number) {
    const [assets] = await db.execute<RowDataPacket[]>('SELECT id FROM fixed_assets WHERE id=? AND company_id=? AND deleted_at IS NULL', [assetId, companyId])
    if (!assets.length) throw new NotFoundError('Aset tidak ditemukan')
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT d.*,j.journal_number,j.status journal_status,r.journal_number reversal_journal_number,r.journal_date reversal_date
       FROM asset_depreciations d
       LEFT JOIN journals j ON j.id=d.journal_id AND j.company_id=d.company_id
       LEFT JOIN journals r ON r.id=d.reversal_journal_id AND r.company_id=d.company_id
       WHERE d.company_id=? AND d.fixed_asset_id=? ORDER BY d.depreciation_date DESC,d.id DESC`,
      [companyId, assetId],
    )
    return rows
  }
  async list(companyId: number, asOf: string) {
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT a.*,COALESCE((SELECT SUM(d.depreciation_amount) FROM asset_depreciations d WHERE d.fixed_asset_id=a.id AND d.company_id=a.company_id AND d.status='posted' AND d.depreciation_date<=?),0) posted_depreciation,
       (SELECT COUNT(*) FROM asset_depreciations d WHERE d.fixed_asset_id=a.id AND d.company_id=a.company_id AND d.status='posted' AND d.depreciation_date<=?) posted_depreciation_count,
       (SELECT d.id FROM asset_depreciations d WHERE d.fixed_asset_id=a.id AND d.status='posted' AND d.depreciation_date<=? ORDER BY d.depreciation_date DESC,d.id DESC LIMIT 1) latest_depreciation_id,
       (SELECT d.depreciation_date FROM asset_depreciations d WHERE d.fixed_asset_id=a.id AND d.status='posted' AND d.depreciation_date<=? ORDER BY d.depreciation_date DESC,d.id DESC LIMIT 1) latest_depreciation_date
       FROM fixed_assets a WHERE a.company_id=? AND a.deleted_at IS NULL AND a.purchase_date<=? ORDER BY a.asset_code`,
      [asOf, asOf, asOf, asOf, companyId, asOf],
    )
    return rows.map((a) => {
      const service = dateOnly(a.in_service_date),
        months = Math.max(
          0,
          (Number(asOf.slice(0, 4)) - Number(service.slice(0, 4))) * 12 +
            Number(asOf.slice(5, 7)) -
            Number(service.slice(5, 7)) +
            1,
        ),
        target = depreciationTarget(
          String(a.purchase_cost),
          String(a.salvage_value),
          Number(a.useful_life_months),
          months, String(a.depreciation_method ?? 'straight_line'),
        ),
        monthly = subtractDecimal(depreciationTarget(
          String(a.purchase_cost),
          String(a.salvage_value),
          Number(a.useful_life_months),
          Number(a.posted_depreciation_count)+1, String(a.depreciation_method ?? 'straight_line'),
        ),String(a.posted_depreciation)),
        nextIndex = Number(a.posted_depreciation_count) + 1,
        nextDate = new Date(Date.UTC(
          Number(service.slice(0, 4)),
          Number(service.slice(5, 7)) - 1 + nextIndex,
          0,
        )).toISOString().slice(0, 10)
      return {
        ...a,
        book_value: subtractDecimal(String(a.purchase_cost), String(a.posted_depreciation)),
        projected_book_value: subtractDecimal(String(a.purchase_cost), target),
        unposted_depreciation: subtractDecimal(target, String(a.posted_depreciation)),
        monthly_depreciation: monthly,
        next_depreciation_date: nextIndex <= Number(a.useful_life_months) ? nextDate : null,
      }
    })
  }
  create(companyId: number, input: AssetInput, context: PostingContext) {
    return idempotentOperation(
      companyId,
      input.request_key,
      'asset-acquisition',
      input,
      async (connection) => {
        const policy=await accountingPolicy(connection,companyId)
        const life=input.life_months ?? Number(policy['accounting.default_asset_life_months']??48)
        const method=policy['accounting.default_depreciation_method']||'straight_line'
        if(compareDecimal(input.cost,policy['accounting.asset_capitalization_threshold']||'0')<0)throw new ValidationError('Nilai di bawah batas kapitalisasi; catat sebagai beban pembelian, bukan aset tetap')
        const validation = new BusinessValidationService()
        if (
          new Set([input.asset_account_id, input.accumulated_account_id, input.expense_account_id])
            .size !== 3
        )
          throw new ValidationError('Ketiga akun aset, akumulasi, dan beban harus berbeda')
        for (const id of [
          input.asset_account_id,
          input.accumulated_account_id,
          input.expense_account_id,
        ])
          await validation.ensureActiveReference(connection, {
            companyId,
            table: 'accounts',
            id,
            label: 'Akun aset',
            postingOnly: true,
          })
        const categoryCode = `A${input.asset_account_id}-${input.accumulated_account_id}-${input.expense_account_id}`
        await connection.execute(
          `INSERT INTO fixed_asset_categories(company_id,code,name,default_useful_life_months,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id) VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=id`,
          [
            companyId,
            categoryCode,
            'Kelompok aset ' + input.asset_account_id,
            life,
            input.asset_account_id,
            input.accumulated_account_id,
            input.expense_account_id,
          ],
        )
        const [categories] = await connection.execute<RowDataPacket[]>(
          'SELECT id FROM fixed_asset_categories WHERE company_id=? AND code=?',
          [companyId, categoryCode],
        )
        const [result] = await connection.execute<ResultSetHeader>(
          `INSERT INTO fixed_assets(company_id,asset_code,asset_name,category_id,purchase_date,in_service_date,purchase_cost,salvage_value,useful_life_months,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,book_value,location,serial_number,reference,status,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?)`,
          [
            companyId,
            input.code,
            input.name,
            categories[0]!.id,
            input.date,
            input.in_service_date,
            input.cost,
            input.salvage_value,
            life,
            input.asset_account_id,
            input.accumulated_account_id,
            input.expense_account_id,
            input.cost,
            input.location,
            input.serial_number,
            input.reference,
            context.userId,
          ],
        )
        await connection.execute('UPDATE fixed_assets SET depreciation_method=? WHERE id=? AND company_id=?',[method,result.insertId,companyId])
        let journalId: number | null = null
        if (!input.already_recorded) {
          if (
            !input.counterpart_account_id ||
            input.counterpart_account_id === input.asset_account_id
          )
            throw new ValidationError('Pilih akun lawan perolehan yang berbeda dari akun aset')
          journalId = await new PostingService().createPostedJournal(connection, {
            companyId,
            sourceType: 'fixed_asset_acquisition',
            sourceId: result.insertId,
            date: input.date,
            reference: input.code,
            description: `Perolehan ${input.name}`,
            context,
            lines: [
              { accountId: input.asset_account_id, debit: input.cost, credit: '0' },
              { accountId: input.counterpart_account_id, debit: '0', credit: input.cost },
            ],
          })
        }
        await new AuditService().log(connection, {
          companyId,
          userId: context.userId,
          module: 'fixed-assets',
          action: 'create',
          recordType: 'fixed_asset',
          recordId: result.insertId,
          recordNumber: input.code,
          newValue: { ...input, life_months: life, depreciation_method: method, capitalization_threshold: policy['accounting.asset_capitalization_threshold']||'0', journalId },
        })
        return { id: result.insertId, journalId }
      },
    )
  }
  depreciate(
    companyId: number,
    input: { request_key: string; asset_id: number; date: string },
    context: PostingContext,
  ) {
    return idempotentOperation(
      companyId,
      input.request_key,
      'asset-depreciation',
      input,
      async (connection) => {
        const period = await new BusinessValidationService().ensureOpenPeriod(
          connection,
          companyId,
          input.date,
        )
        const [rows] = await connection.execute<RowDataPacket[]>(
          'SELECT * FROM fixed_assets WHERE id=? AND company_id=? AND deleted_at IS NULL FOR UPDATE',
          [input.asset_id, companyId],
        )
        const asset = rows[0]
        if (!asset) throw new NotFoundError('Aset tidak ditemukan')
        if (asset.status !== 'active') throw new ConflictError('Aset harus aktif')
        const monthEnd = new Date(
          Date.UTC(Number(input.date.slice(0, 4)), Number(input.date.slice(5, 7)), 0),
        )
          .toISOString()
          .slice(0, 10)
        if (input.date !== monthEnd)
          throw new ValidationError('Penyusutan diposting pada tanggal akhir bulan')
        const service = dateOnly(asset.in_service_date)
        if (input.date < service) throw new ValidationError('Aset belum mulai digunakan')
        const [prior] = await connection.execute<RowDataPacket[]>(
          `SELECT COUNT(*) n,COALESCE(SUM(depreciation_amount),0) total,MAX(depreciation_date) last_date FROM asset_depreciations WHERE fixed_asset_id=? AND company_id=? AND status='posted'`,
          [input.asset_id, companyId],
        )
        const months =
          (Number(input.date.slice(0, 4)) - Number(service.slice(0, 4))) * 12 +
          Number(input.date.slice(5, 7)) -
          Number(service.slice(5, 7)) +
          1
        if (months !== Number(prior[0]!.n) + 1)
          throw new ConflictError(
            'Posting penyusutan harus berurutan mulai bulan aset digunakan; periode ini mungkin sudah diposting',
          )
        const target = depreciationTarget(
            String(asset.purchase_cost),
            String(asset.salvage_value),
            Number(asset.useful_life_months),
            months, String(asset.depreciation_method ?? 'straight_line'),
          ),
          amount = subtractDecimal(target, String(prior[0]!.total))
        if (compareDecimal(amount, '0') <= 0)
          throw new ConflictError('Tidak ada penyusutan tersisa untuk periode ini')
        const opening = subtractDecimal(String(asset.purchase_cost), String(prior[0]!.total)),
          closing = subtractDecimal(String(asset.purchase_cost), target)
        const [created] = await connection.execute<ResultSetHeader>(
          `INSERT INTO asset_depreciations(company_id,fixed_asset_id,accounting_period_id,depreciation_date,opening_book_value,depreciation_amount,accumulated_depreciation,closing_book_value,status,created_by) VALUES(?,?,?,?,?,?,?,?,'draft',?)`,
          [
            companyId,
            input.asset_id,
            period.id,
            input.date,
            opening,
            amount,
            target,
            closing,
            context.userId,
          ],
        )
        const journalId = await new PostingService().createPostedJournal(connection, {
          companyId,
          sourceType: 'asset_depreciation',
          sourceId: created.insertId,
          date: input.date,
          reference: String(asset.asset_code),
          description: `Penyusutan ${asset.asset_name} ${input.date.slice(0, 7)}`,
          context,
          lines: [
            {
              accountId: Number(asset.depreciation_expense_account_id),
              debit: amount,
              credit: '0',
            },
            {
              accountId: Number(asset.accumulated_depreciation_account_id),
              debit: '0',
              credit: amount,
            },
          ],
        })
        await connection.execute(
          `UPDATE asset_depreciations SET status='posted',journal_id=?,posted_by=?,posted_at=NOW() WHERE id=?`,
          [journalId, context.userId, created.insertId],
        )
        await connection.execute(
          'UPDATE fixed_assets SET accumulated_depreciation=?,book_value=?,status=?,version=version+1 WHERE id=?',
          [
            target,
            closing,
            months >= Number(asset.useful_life_months) ? 'fully_depreciated' : 'active',
            input.asset_id,
          ],
        )
        await new AuditService().log(connection, {
          companyId,
          userId: context.userId,
          module: 'asset-depreciation',
          action: 'post',
          recordType: 'asset_depreciation',
          recordId: created.insertId,
          newValue: { amount, journalId },
        })
        return { id: created.insertId, journalId, amount, closing }
      },
    )
  }
  reverseDepreciation(companyId: number, id: number, input: ReversalInput, context: PostingContext) {
    return idempotentOperation(companyId, input.request_key, 'asset-depreciation-reverse', { id, ...input }, async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(`SELECT d.*,a.purchase_cost,a.useful_life_months FROM asset_depreciations d JOIN fixed_assets a ON a.id=d.fixed_asset_id AND a.company_id=d.company_id WHERE d.id=? AND d.company_id=? FOR UPDATE`, [id, companyId])
      const depreciation = rows[0]
      if (!depreciation) throw new NotFoundError('Penyusutan tidak ditemukan')
      if (depreciation.status !== 'posted') throw new ConflictError('Hanya penyusutan posted yang dapat direversal')
      if (input.date < dateOnly(depreciation.depreciation_date)) throw new ValidationError('Tanggal reversal tidak boleh sebelum tanggal penyusutan')
      const [later] = await connection.execute<RowDataPacket[]>("SELECT id FROM asset_depreciations WHERE fixed_asset_id=? AND company_id=? AND status='posted' AND depreciation_date>? LIMIT 1", [depreciation.fixed_asset_id, companyId, depreciation.depreciation_date])
      if (later.length) throw new ConflictError('Balikkan penyusutan bulan terakhir terlebih dahulu')
      const reversalJournalId = await new PostingService().reversePostedJournal(connection, { companyId, journalId: Number(depreciation.journal_id), date: input.date, reason: input.reason, context, sourceType: 'asset_depreciation_reversal', sourceId: id })
      await connection.execute("UPDATE asset_depreciations SET status='reversed',reversal_journal_id=?,reversed_by=?,reversed_at=NOW() WHERE id=?", [reversalJournalId, context.userId, id])
      const [totals] = await connection.execute<RowDataPacket[]>("SELECT COALESCE(SUM(depreciation_amount),0) total FROM asset_depreciations WHERE fixed_asset_id=? AND company_id=? AND status='posted'", [depreciation.fixed_asset_id, companyId])
      const total = String(totals[0]!.total), book = subtractDecimal(String(depreciation.purchase_cost), total)
      await connection.execute("UPDATE fixed_assets SET accumulated_depreciation=?,book_value=?,status='active',version=version+1 WHERE id=?", [total, book, depreciation.fixed_asset_id])
      await new AuditService().log(connection, { companyId, userId: context.userId, module: 'depreciation', action: 'reverse', recordType: 'asset_depreciation', recordId: id, newValue: { reversalJournalId, reason: input.reason } })
      return { id, status: 'reversed', reversalJournalId, bookValue: book }
    })
  }

  reverseAsset(companyId: number, id: number, input: ReversalInput, context: PostingContext) {
    return idempotentOperation(companyId, input.request_key, 'fixed-asset-reverse', { id, ...input }, async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>('SELECT * FROM fixed_assets WHERE id=? AND company_id=? AND deleted_at IS NULL FOR UPDATE', [id, companyId])
      const asset = rows[0]
      if (!asset) throw new NotFoundError('Aset tidak ditemukan')
      if (!['active','fully_depreciated'].includes(String(asset.status))) throw new ConflictError('Aset sudah tidak aktif')
      if (input.date < dateOnly(asset.purchase_date)) throw new ValidationError('Tanggal reversal tidak boleh sebelum perolehan')
      const [depreciations] = await connection.execute<RowDataPacket[]>("SELECT id FROM asset_depreciations WHERE fixed_asset_id=? AND company_id=? AND status='posted' LIMIT 1", [id, companyId])
      if (depreciations.length) throw new ConflictError('Balikkan seluruh penyusutan posted terlebih dahulu')
      const [journals] = await connection.execute<RowDataPacket[]>("SELECT id FROM journals WHERE company_id=? AND source_type='fixed_asset_acquisition' AND source_id=? AND status='posted' LIMIT 1 FOR UPDATE", [companyId, id])
      const reversalJournalId = journals[0] ? await new PostingService().reversePostedJournal(connection, { companyId, journalId: Number(journals[0].id), date: input.date, reason: input.reason, context, sourceType: 'fixed_asset_acquisition_reversal', sourceId: id }) : null
      await connection.execute("UPDATE fixed_assets SET status='inactive',updated_by=?,version=version+1 WHERE id=?", [context.userId, id])
      await new AuditService().log(connection, { companyId, userId: context.userId, module: 'fixed-assets', action: 'reverse', recordType: 'fixed_asset', recordId: id, recordNumber: String(asset.asset_code), newValue: { reversalJournalId, reason: input.reason } })
      return { id, status: 'inactive', reversalJournalId }
    })
  }
}
