import {ReportingService} from './ReportingService'
import {ReportRepository} from '../repositories/ReportRepository'
import type {QueryExecutor} from '../types/database'
export async function financialExport(connection:QueryExecutor,companyId:number,report:string,dateFrom:string,dateTo:string) {
  const service=new ReportingService(new ReportRepository(connection)),range={dateFrom,dateTo}
  let rows:Record<string,unknown>[]=[],columns:[string,string][]=[['code','Nomor Akun'],['label','Uraian'],['value','Nilai']],title=''
  const total=(label:string,value:unknown)=>rows.push({code:'',label,value})
  const section=(label:string,accounts:{code:string;name:string;amount:string}[],value:string)=>{
    rows.push({code:'',label,value:''});rows.push(...accounts.map(a=>({code:a.code,label:a.name,value:a.amount})));total(`Total ${label}`,value)
  }
  if(report==='profit_loss'){
    const data=await service.profitLoss(companyId,range);title='Laporan Laba Rugi'
    section('Pendapatan',data.sections.revenue.accounts,data.sections.revenue.total)
    section('Harga Pokok Penjualan',data.sections.cogs.accounts,data.sections.cogs.total);total('Laba Kotor',data.grossProfit)
    section('Beban Operasional',data.sections.operatingExpenses.accounts,data.sections.operatingExpenses.total);total('Laba Operasional',data.operatingProfit)
    section('Pendapatan Lain',data.sections.otherIncome.accounts,data.sections.otherIncome.total)
    section('Beban Lain',data.sections.otherExpense.accounts,data.sections.otherExpense.total);total('Laba Sebelum Pajak',data.profitBeforeTax)
    section('Beban Pajak',data.sections.tax.accounts,data.sections.tax.total);total('Laba Bersih',data.netProfit)
  }else if(report==='balance_sheet'){
    const data=await service.balanceSheet(companyId,dateTo);title='Laporan Posisi Keuangan'
    section('Aset',data.sections.assets.accounts,data.assets)
    section('Liabilitas',data.sections.liabilities.accounts,data.liabilities)
    section('Ekuitas Akun',data.sections.equity.accounts,data.sections.equity.accountTotal)
    total('Laba periode lalu belum ditutup',data.sections.equity.unclosedPriorEarnings)
    total('Laba periode fiskal berjalan',data.sections.equity.currentYearEarnings)
    total('Total Ekuitas',data.equity);total('Total Liabilitas dan Ekuitas',data.liabilitiesAndEquity);total('Selisih',data.difference)
  }else if(report==='cash_flow'){
    const data=await service.cashFlow(companyId,range);title='Laporan Arus Kas'
    total('Saldo Awal',data.openingBalance);total('Aktivitas Operasional',data.activities.operating);total('Aktivitas Investasi',data.activities.investing);total('Aktivitas Pendanaan',data.activities.financing);total('Perubahan Bersih',data.netChange);total('Saldo Akhir',data.endingBalance);total('Selisih Rekonsiliasi',data.difference)
  }else{
    const data=await service.trialBalance(companyId,range);title='Neraca Saldo'
    columns=[['code','Nomor Akun'],['name','Nama COA'],['openingDebit','Awal Debit'],['openingCredit','Awal Kredit'],['periodDebit','Mutasi Debit'],['periodCredit','Mutasi Kredit'],['endingDebit','Akhir Debit'],['endingCredit','Akhir Kredit']]
    rows=[...data.accounts,{code:'',name:'TOTAL',...data.totals}]
  }
  return {title,columns,rows}
}
