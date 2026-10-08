import { ConflictError } from '../utils/AppError'
export function assertAccountingDate(date:string, today:string, policy:Record<string,unknown>) {
  const lock=String(policy['accounting.transaction_lock_date']??'')
  if(lock&&date<=lock)throw new ConflictError(`Transaksi sampai ${lock} dikunci oleh kebijakan perusahaan`)
  if(String(policy['accounting.allow_future_dates']??'true')==='false'&&date>today)throw new ConflictError('Tanggal transaksi masa depan tidak diizinkan oleh kebijakan perusahaan')
  const days=Number(policy['accounting.max_backdate_days']??0)
  const age=(Date.parse(`${today}T00:00:00Z`)-Date.parse(`${date}T00:00:00Z`))/86400000
  if(days>0&&age>days)throw new ConflictError(`Tanggal transaksi melewati batas tanggal mundur ${days} hari`)
}
