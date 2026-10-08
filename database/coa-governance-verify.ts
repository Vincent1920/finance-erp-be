import { validateFxPolicy } from '../services/AccountingPolicyService'
import { FixedAssetService } from '../services/FixedAssetService'
import { assetSchema } from '../validators/operations.validator'
import { SettingsService } from '../services/SettingsService'
import { BusinessValidationService } from '../services/BusinessValidationService'
import assert from 'node:assert/strict'
import { db,transaction } from '../config/database'
import { CoaGovernanceService } from '../services/CoaGovernanceService'
import { EntityService } from '../services/EntityService'
import { AccountMappingService } from '../services/AccountMappingService'
import { assertManualAccounts } from '../services/CoaControlService'
import { addDecimal } from '../utils/decimal'

export async function verifyCoaGovernance(userId:number,reviewerId:number,revenueId:number) {
  assert.match(String(process.env.DB_NAME),/^finora_verify_\d+_\d+$/)
  const service=new CoaGovernanceService(),accounts=new EntityService('accounts')
  const actor={id:userId,companyId:1,roles:['super-admin']},reviewer={...actor,id:reviewerId}
  const settings=new SettingsService(),validation=new BusinessValidationService()
  const configure=async(key:string,value:string|number,type:'string'|'number'='string')=>settings.updateMany(actor,[{key,value,value_type:type,category:'accounting',is_secret:false}])
  await db.execute("INSERT IGNORE INTO currencies(code,name,is_active) VALUES('USD','US Dollar',TRUE),('IDR','Rupiah',TRUE)")
  await db.execute("INSERT INTO exchange_rates(company_id,rate_date,from_currency,to_currency,exchange_rate,source,created_by) VALUES(1,'2026-01-01','USD','IDR',16000,'policy-test',?) ON DUPLICATE KEY UPDATE exchange_rate=16000,source='policy-test'",[userId])
  await configure('accounting.fx_rate_policy','registered')
  await configure('accounting.fx_max_rate_age_days',7,'number')
  await configure('accounting.fx_rate_source','policy-test')
  await transaction(cx=>validateFxPolicy(cx,1,'USD','2026-01-02','16000'))
  await assert.rejects(()=>transaction(cx=>validateFxPolicy(cx,1,'USD','2026-01-02','15000')),/sesuai kurs/)
  await assert.rejects(()=>transaction(cx=>validateFxPolicy(cx,1,'USD','2025-12-31','16000')),/belum tersedia/)
  await assert.rejects(()=>transaction(cx=>validateFxPolicy(cx,1,'USD','2026-01-10','16000')),/batas usia/)
  await configure('accounting.fx_rate_source','other-source')
  await assert.rejects(()=>transaction(cx=>validateFxPolicy(cx,1,'USD','2026-01-02','16000')),/Sumber kurs/)
  await configure('accounting.fx_rate_source','')
  await configure('accounting.fx_rate_policy','manual')
  await assert.rejects(()=>transaction(cx=>validateFxPolicy(cx,1,'IDR','2026-01-02','2')),/harus 1/)
  const aa=await accounts.create(1,{code:'POL-ASSET',name:'Policy asset',account_type:'asset',normal_balance:'debit',is_posting:true,is_active:true},{userId})
  const ac=await accounts.create(1,{code:'POL-ACCUM',name:'Policy accumulated',account_type:'asset',normal_balance:'credit',is_posting:true,is_active:true},{userId})
  const ae=await accounts.create(1,{code:'POL-EXP',name:'Policy depreciation',account_type:'expense',normal_balance:'debit',is_posting:true,is_active:true},{userId})
  await configure('accounting.asset_capitalization_threshold',100,'number')
  await configure('accounting.default_asset_life_months',12,'number')
  await configure('accounting.default_depreciation_method','declining_balance')
  const createInput=(cost:number)=>assetSchema.parse({request_key:crypto.randomUUID(),code:'POL-ASSET-VERIFY',name:'Policy test asset',date:'2026-01-02',in_service_date:'2026-01-02',cost,asset_account_id:aa!.id,accumulated_account_id:ac!.id,expense_account_id:ae!.id,already_recorded:true})
  const assets=new FixedAssetService()
  await assert.rejects(()=>assets.create(1,createInput(99),{userId}),/batas kapitalisasi/)
  const created=await assets.create(1,createInput(12000),{userId})
  await configure('accounting.default_depreciation_method','straight_line')
  const [snapshot]=await db.execute<any[]>('SELECT depreciation_method,useful_life_months FROM fixed_assets WHERE id=?',[created.id])
  assert.equal(snapshot[0].depreciation_method,'declining_balance')
  assert.equal(Number(snapshot[0].useful_life_months),12)
  await assets.depreciate(1,{request_key:crypto.randomUUID(),asset_id:created.id,date:'2026-01-31'},{userId})
  const [depreciation]=await db.execute<any[]>('SELECT depreciation_amount,closing_book_value FROM asset_depreciations WHERE fixed_asset_id=? AND status=\'posted\'',[created.id])
  assert.equal(Number(depreciation[0].depreciation_amount),2000)
  assert.equal(Number(depreciation[0].closing_book_value),10000)
  const projection=(await assets.list(1,'2026-01-31')).find(a=>Number((a as any).id)===created.id)!
  assert.equal(Number(projection.projected_book_value),10000)
  assert.equal(Number(projection.book_value),10000)
  await assert.rejects(()=>settings.updateMany(actor,[{key:'accounting.fx_unrealized_gain_account_id',value:aa!.id,value_type:'account_id',category:'accounting',is_secret:false}]),/Tipe akun/)

  await configure('accounting.asset_capitalization_threshold',0,'number')
  await configure('accounting.default_asset_life_months',48,'number')
  console.log('PASS FX policy: missing, stale, mismatched, source and base-rate guards; asset capitalization, default life and historical method snapshot')
  await settings.updateMany(actor,[{key:'accounting.transaction_lock_date',value:'2026-12-31',value_type:'string',category:'accounting',is_secret:false}])
  await assert.rejects(()=>transaction(cx=>validation.ensureOpenPeriod(cx,1,'2026-01-02')),/dikunci/)
  await settings.updateMany(actor,[{key:'accounting.transaction_lock_date',value:'',value_type:'string',category:'accounting',is_secret:false},{key:'accounting.max_backdate_days',value:1,value_type:'number',category:'accounting',is_secret:false}])
  await assert.rejects(()=>transaction(cx=>validation.ensureOpenPeriod(cx,1,'2026-01-02')),/tanggal mundur/)
  await settings.updateMany(actor,[{key:'accounting.max_backdate_days',value:0,value_type:'number',category:'accounting',is_secret:false},{key:'accounting.allow_future_dates',value:false,value_type:'boolean',category:'accounting',is_secret:false}])
  const tomorrow=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()+86400000))
  await assert.rejects(()=>transaction(cx=>validation.ensureOpenPeriod(cx,1,tomorrow)),/masa depan/)
  await settings.updateMany(actor,[{key:'accounting.allow_future_dates',value:true,value_type:'boolean',category:'accounting',is_secret:false}])
  await assert.rejects(()=>settings.updateMany(actor,[{key:'accounting.transaction_lock_date',value:'2026-02-31',value_type:'string',category:'accounting',is_secret:false}]))
  console.log('PASS accounting date policy: database cutoff, backdate, future date and invalid calendar validation')
  const [controls]=await db.query<any[]>("SELECT account_id FROM account_mappings WHERE company_id=1 AND mapping_key='AR_CONTROL'")
  await assert.rejects(()=>transaction(cx=>assertManualAccounts(cx,1,[Number(controls[0].account_id)])))
  await assert.rejects(()=>accounts.update(revenueId,1,{name:'Unapproved'},{userId}))
  const a=await service.propose(actor,{kind:'account',target_id:revenueId,changes:{name:'Governed revenue A'},reason:'Verification change A'})
  const b=await service.propose(actor,{kind:'account',target_id:revenueId,changes:{name:'Governed revenue B'},reason:'Verification change B'})
  await assert.rejects(()=>service.review(actor,a.id,true,'Self approval rejected'))
  const concurrent=await Promise.allSettled([service.review(reviewer,a.id,true,'Verified by reviewer'),service.review(reviewer,b.id,true,'Concurrent reviewer')])
  assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1)
  assert.equal(concurrent.filter(r=>r.status==='rejected').length,1)
  await assert.rejects(()=>service.review({...reviewer,companyId:999999},a.id,false,'Another company rejected'))
  for(const industry of ['trading','services','manufacturing']){
    const [company]=await db.execute<any>('INSERT INTO companies(name) VALUES(?)',[`COA ${industry}`])
    const newActor={...actor,companyId:Number(company.insertId)}
    await service.installTemplate(newActor,industry)
    const state=await service.overview(newActor.companyId)
    assert.equal(state.ready,true)
    assert.ok(state.accounts.every(a=>/^\d{6}$/.test(String(a.code))))
    assert.ok(state.accounts.filter(a=>a.is_control).every(a=>!a.manual_effectively_allowed))
    await assert.rejects(()=>service.installTemplate(newActor,industry))
    const headers=state.accounts.filter(a=>a.is_header)
    const children=state.accounts.filter(a=>a.parent_id===headers[0]!.id)
    await assert.rejects(()=>accounts.update(Number(headers[0]!.id),newActor.companyId,{parent_id:Number(children[0]!.id)},{userId}))
    await assert.rejects(()=>accounts.update(Number(headers[0]!.id),newActor.companyId,{parent_id:Number(headers[0]!.id)},{userId}))
    await assert.rejects(()=>accounts.update(Number(children[0]!.id),newActor.companyId,{parent_id:Number(headers[1]!.id)},{userId}))
    // Concurrent reparenting of two header accounts cannot create a cycle.
    const h1=await accounts.create(newActor.companyId,{code:'190001',name:'Header A',account_type:'asset',normal_balance:'debit',is_header:true,is_posting:false,is_active:true},{userId})
    const h2=await accounts.create(newActor.companyId,{code:'190002',name:'Header B',account_type:'asset',normal_balance:'debit',is_header:true,is_posting:false,is_active:true},{userId})
    const moves=await Promise.allSettled([accounts.update(Number(h1!.id),newActor.companyId,{parent_id:Number(h2!.id)},{userId}),accounts.update(Number(h2!.id),newActor.companyId,{parent_id:Number(h1!.id)},{userId})])
    assert.equal(moves.filter(r=>r.status==='fulfilled').length,1)
  }
  const grouped=await service.groupedReport(1,'2026-12-31')
  assert.equal(addDecimal(grouped.groups.map(g=>g.debit)),grouped.totalDebit)
  assert.equal(addDecimal(grouped.groups.map(g=>g.credit)),grouped.totalCredit)
  await assert.rejects(()=>transaction(cx=>new AccountMappingService().ensureReadyFor(cx,999999,['AR_CONTROL','AP_CONTROL'])))
  console.log('PASS COA governance: manual control guard, readiness, maker-checker, concurrent stale approval, tenant isolation, 3 industry templates, hierarchy cycle concurrency and exact group subtotals')
}
