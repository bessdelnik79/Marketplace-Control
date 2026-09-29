import { financialParserVersion } from '../reports/finance.mjs';
import {
  calculateFinancialResult,calculateStoreTaxReference,createInputFingerprint,isVerifiedWbResultComponent
} from './calculation.mjs';
import {
  createConfirmedReturnLinks,loadCalculationReportCandidates,reportPeriodsCoverRange,selectFullyNormalizedReportPeriods
} from './calculation.repository.mjs';
import {
  buildDailyFinancialGeneration,combineDailyFinancialGenerations,compareDailyGenerationToLegacy
} from './daily-generation.mjs';
import {createFinancialDailyPublicationRepository} from './daily-publication.repository.mjs';

const groupBy=(rows,key)=>rows.reduce((map,row)=>{const value=key(row),group=map.get(value)??[];group.push(row);map.set(value,group);return map;},new Map());
const periodKey=row=>`${row.period_start}/${row.period_end}`;

export function financialDailyAffectedEmptyWeeks(rows,periodStart,periodEnd){
  return rows.filter(row=>row.period_end>=periodStart&&row.period_start<=periodEnd);
}

export function financialDailyDateOnly(value){
  if(value instanceof Date&&!Number.isNaN(value.getTime())){
    const year=value.getFullYear(),month=String(value.getMonth()+1).padStart(2,'0'),day=String(value.getDate()).padStart(2,'0');
    return`${year}-${month}-${day}`;
  }
  const text=String(value??'');
  if(/^\d{4}-\d{2}-\d{2}$/.test(text))return text;
  throw new Error('financial_daily_invalid_job');
}

function fillCoverageGaps(daily,periodStart,periodEnd){
  const byDate=new Map(daily.days.map(day=>[day.accountingDate,day]));
  for(let cursor=new Date(`${periodStart}T00:00:00Z`),end=new Date(`${periodEnd}T00:00:00Z`);cursor<=end;cursor.setUTCDate(cursor.getUTCDate()+1)){
    const accountingDate=cursor.toISOString().slice(0,10);
    if(!byDate.has(accountingDate))byDate.set(accountingDate,{
      accountingDate,coverageComplete:false,taxUsable:false,quality:'unavailable',missingReasons:['report_coverage_incomplete'],
      selectedProductsResultBeforeTax:null,storeLevelResultBeforeTax:null,availableResultBeforeTax:null
    });
  }
  daily.days=[...byDate.values()].sort((a,b)=>a.accountingDate.localeCompare(b.accountingDate));
  daily.periodStart=periodStart;daily.periodEnd=periodEnd;
  daily.coverageComplete=daily.days.every(day=>day.coverageComplete);
  daily.taxUsable=daily.days.every(day=>day.taxUsable);
  daily.quality=daily.days.some(day=>day.quality==='unavailable')?'unavailable':daily.days.some(day=>day.quality==='partial')?'partial':'complete';
  daily.missingReasons=[...new Set(daily.days.flatMap(day=>day.missingReasons))].sort();
  return daily;
}

async function transaction(pool,action){
  const client=await pool.connect();
  try{await client.query('begin');const result=await action(client);await client.query('commit');return result;}
  catch(error){await client.query('rollback');throw error;}
  finally{client.release();}
}

async function establish(client,jobId,leaseToken,workerId){
  const context=(await client.query('select * from mc.establish_financial_daily_context($1,$2,$3)',[jobId,leaseToken,workerId])).rows[0]??null;
  if(context){context.affected_from=financialDailyDateOnly(context.affected_from);context.affected_to=financialDailyDateOnly(context.affected_to);}
  return context;
}

async function loadSnapshot(client,context){
  const{business_id:businessId,store_id:storeId}=context;
  const selection=(await client.query(`select id from mc.product_selections where business_id=$1 and store_id=$2 and status='confirmed'`,[businessId,storeId])).rows[0];
  if(!selection)throw new Error('financial_daily_selection_missing');
  const products=(await client.query(`select product_id from mc.product_selection_items where selection_id=$1 order by product_id`,[selection.id])).rows.map(row=>row.product_id);
  if(!products.length)throw new Error('financial_daily_selection_missing');
  const candidates=await loadCalculationReportCandidates(client,businessId,storeId);
  const reports=selectFullyNormalizedReportPeriods(candidates).filter(row=>row.period_start<=context.affected_to);
  const affectedReports=reports.filter(row=>row.period_end>=context.affected_from&&row.period_start<=context.affected_to);
  const eligibleEmptyWeeks=(await client.query(
    `select wc.id,wc.empty_confirmed_by_job_id,wc.week_start::text as period_start,wc.week_end::text as period_end
       from mc.financial_week_coverage wc
       join mc.connections connection on connection.business_id=wc.business_id and connection.store_id=wc.store_id
        and connection.status='active' and connection.scopes ? 'finance'
        and connection.credential_generation=wc.credential_generation
      where wc.business_id=$1 and wc.store_id=$2 and wc.coverage_status='empty'
        and wc.empty_confirmed_by_job_id is not null and wc.week_start<=$3
      order by wc.week_start,wc.id`,[businessId,storeId,context.affected_to])).rows
    .filter(row=>!affectedReports.some(report=>report.period_start<=row.period_end&&report.period_end>=row.period_start));
  const emptyWeeks=financialDailyAffectedEmptyWeeks(eligibleEmptyWeeks,context.affected_from,context.affected_to);
  const affectedPeriods=[...affectedReports,...emptyWeeks];
  if(!affectedPeriods.length)throw new Error('financial_daily_inputs_missing');
  const affectedStart=affectedPeriods.reduce((value,row)=>row.period_start<value?row.period_start:value,affectedPeriods[0].period_start);
  const affectedEnd=affectedPeriods.reduce((value,row)=>row.period_end>value?row.period_end:value,affectedPeriods[0].period_end);
  const method=(await client.query(`select id,implementation_version from mc.method_versions where code='financial_result' and version_no=28`,[])).rows[0];
  if(!method)throw new Error('financial_daily_method_missing');
  const normalizationIds=reports.map(row=>row.normalization_id);
  const parserMethods=normalizationIds.length?(await client.query(
    `select distinct n.method_version_id,m.implementation_version from mc.report_normalizations n join mc.method_versions m on m.id=n.method_version_id
      where n.id=any($1::uuid[]) and m.code='wb_finance_import'`,[normalizationIds])).rows:(await client.query(
    `select id as method_version_id,implementation_version from mc.method_versions
      where code='wb_finance_import' and implementation_version=$1 order by version_no desc limit 1`,[financialParserVersion])).rows;
  if(parserMethods.length!==1||parserMethods[0].implementation_version!==financialParserVersion)throw new Error('financial_daily_method_missing');
  const operationLinks=await createConfirmedReturnLinks(client,businessId,storeId,normalizationIds,method.id);
  const components=(await client.query(
    `select f.id,f.category_code,f.source_field,f.amount_signed::text,f.result_scope_classification,
            o.id as operation_version_id,o.product_id,o.variant_id,o.accounting_date::text,o.state,o.operation_type,
            rr.raw_data->>'docTypeName' as doc_type_name,rr.raw_data->>'sellerOperName' as seller_oper_name,
            rr.raw_data->>'bonusTypeName' as bonus_type_name,rr.raw_data->>'nmId' as wb_article,rr.raw_data->>f.source_field as raw_value
       from mc.operation_versions o join mc.financial_components f on f.operation_version_id=o.id
       join mc.report_rows rr on rr.id=o.report_row_id
      where o.report_normalization_id=any($1::uuid[]) order by f.id`,[normalizationIds])).rows.map(row=>({
        id:row.id,operationVersionId:row.operation_version_id,categoryCode:row.category_code,sourceField:row.source_field,
        rawValue:row.raw_value,amountSigned:row.amount_signed,productId:row.product_id,variantId:row.variant_id,wbArticle:row.wb_article,
        accountingDate:row.accounting_date,state:row.state,operationType:row.operation_type,docTypeName:row.doc_type_name,
        sellerOperName:row.seller_oper_name,bonusTypeName:row.bonus_type_name,scopeCode:row.result_scope_classification,
        classificationStatus:isVerifiedWbResultComponent({categoryCode:row.category_code,sourceField:row.source_field,
          operationType:row.operation_type,docTypeName:row.doc_type_name,sellerOperName:row.seller_oper_name,
          bonusTypeName:row.bonus_type_name,rawValue:row.raw_value,scopeCode:row.result_scope_classification})?'confirmed':'unclassified'
      }));
  const operations=(await client.query(
    `select o.id,o.report_row_id,o.report_normalization_id,o.operation_type,o.product_id,o.variant_id,o.accounting_date::text,o.quantity::text,o.state,
            rr.raw_data->>'docTypeName' as doc_type_name,rr.raw_data->>'sellerOperName' as seller_oper_name,rr.raw_data->>'nmId' as wb_article
       from mc.operation_versions o join mc.report_rows rr on rr.id=o.report_row_id
      where o.report_normalization_id=any($1::uuid[]) and o.operation_type in ('sale','return') order by o.id`,[normalizationIds])).rows.map(row=>({
        id:row.id,reportRowId:row.report_row_id,reportNormalizationId:row.report_normalization_id,operationType:row.operation_type,productId:row.product_id,
        variantId:row.variant_id,wbArticle:row.wb_article,accountingDate:row.accounting_date,quantity:row.quantity,state:row.state,
        docTypeName:row.doc_type_name,sellerOperName:row.seller_oper_name,scopeCode:'selected_product'
      }));
  const costs=(await client.query(
    `select v.id,c.variant_id,c.effective_from::text,v.unit_cost::text from mc.variant_costs c join mc.cost_versions v on v.id=c.current_version_id
      where c.business_id=$1 and c.store_id=$2 and c.product_id=any($3::uuid[]) and c.effective_from<=$4 order by v.id`,
    [businessId,storeId,products,affectedEnd])).rows.map(row=>({id:row.id,variantId:row.variant_id,effectiveFrom:row.effective_from,unitCost:row.unit_cost}));
  const expenses=(await client.query(
    `select v.id,e.product_id,v.category,v.amount::text,v.period_start::text,v.period_end::text,v.recognition_method,v.state
       from mc.expenses e join mc.expense_versions v on v.id=e.current_version_id
      where e.business_id=$1 and e.store_id=$2 and v.state='active' and v.period_end>=$3 and v.period_start<=$4
        and(e.product_id is null or e.product_id=any($5::uuid[])) order by v.id`,
    [businessId,storeId,affectedStart,affectedEnd,products])).rows.map(row=>({id:row.id,productId:row.product_id,category:row.category,
      amount:row.amount,periodStart:row.period_start,periodEnd:row.period_end,recognitionMethod:row.recognition_method,state:row.state,
      scopeCode:row.product_id?'selected_product':'store'}));
  const taxSettings=(await client.query(
    `select v.id,s.effective_from::text,v.regime_code,v.usn_rate_fraction::text,v.vat_mode,v.state
       from mc.tax_settings s join mc.tax_setting_versions v on v.id=s.current_version_id
      where s.business_id=$1 and s.effective_from<=$2 order by s.effective_from,v.id`,[businessId,affectedEnd])).rows;
  const fingerprint=createInputFingerprint({resultMethodVersion:`${method.id}:${method.implementation_version}`,selectedProductIds:products,
    reportVersionIds:reports.map(row=>row.report_version_id),reportNormalizationIds:normalizationIds,costVersionIds:costs.map(row=>row.id),
    emptyWeekCoverageIds:emptyWeeks.map(row=>`${row.id}:${row.empty_confirmed_by_job_id}`),
    operationLinkIds:operationLinks.map(link=>link.id),expenseVersionIds:expenses.map(row=>row.id),taxSettingVersionIds:taxSettings.map(row=>row.id),
    periodStart:affectedStart,periodEnd:affectedEnd});
  return{businessId,storeId,selection,products,reports,affectedReports,emptyWeeks,affectedStart,affectedEnd,method,
    parserMethod:parserMethods[0],operationLinks,components,operations,costs,expenses,taxSettings,fingerprint};
}

export function calculateFinancialPeriods(snapshot){
  const groups=[...groupBy(snapshot.affectedReports,periodKey).values()].sort((a,b)=>a[0].period_start.localeCompare(b[0].period_start));
  const periods=[...groups.map(rows=>({rows,periodStart:rows[0].period_start,periodEnd:rows[0].period_end})),
    ...snapshot.emptyWeeks.map(row=>({rows:[],periodStart:row.period_start,periodEnd:row.period_end}))]
    .sort((a,b)=>a.periodStart.localeCompare(b.periodStart)||a.periodEnd.localeCompare(b.periodEnd));
  return periods.map(({rows,periodStart,periodEnd})=>{
    const coverageComplete=rows.length===0||(rows.every(row=>row.normalization_id)&&reportPeriodsCoverRange(rows,periodStart,periodEnd));
    const retail=snapshot.components.filter(row=>row.sourceField==='retailAmount');
    const retailIds=new Set(retail.map(row=>String(row.operationVersionId)));
    const missing=snapshot.operations.filter(row=>!retailIds.has(String(row.id))).map(row=>({id:`missing-retail:${row.id}`,productId:row.productId,wbArticle:row.wbArticle,
      accountingDate:row.accountingDate,retailAmount:null,docTypeName:row.docTypeName,sellerOperName:row.sellerOperName,state:row.state}));
    const taxReference=calculateStoreTaxReference({periodStart,periodEnd,selectedProductIds:snapshot.products,
      sourceRows:[...retail.map(row=>({id:row.id,productId:row.productId,wbArticle:row.wbArticle,accountingDate:row.accountingDate,retailAmount:row.rawValue,
        docTypeName:row.docTypeName,sellerOperName:row.sellerOperName,state:row.state})),...missing],
      taxSettings:snapshot.taxSettings.map(row=>({id:row.id,effectiveFrom:row.effective_from,regimeCode:row.regime_code,
        usnRateFraction:row.usn_rate_fraction,vatMode:row.vat_mode,state:row.state})),reportCoverageComplete:coverageComplete});
    const currentTax=snapshot.taxSettings.filter(row=>row.effective_from<=periodEnd).at(-1)??null;
    const result=calculateFinancialResult({periodStart,periodEnd,resultMethodVersion:snapshot.method?.implementation_version??'financial-result-v28',selectedProductIds:snapshot.products,financialComponents:snapshot.components,
      operations:snapshot.operations,operationLinks:snapshot.operationLinks,costVersions:snapshot.costs,expenses:snapshot.expenses,
      taxSetting:currentTax?{regimeCode:currentTax.regime_code,usnRateFraction:currentTax.usn_rate_fraction,vatMode:currentTax.vat_mode,state:currentTax.state}:null,
      taxReference,reportCoverageComplete:coverageComplete,allowEmptyResult:rows.length===0});
    return buildDailyFinancialGeneration({periodStart,periodEnd,result,taxReference,coverageComplete});
  });
}

async function persistGeneration(client,context,snapshot,generation,daily){
  const args=[snapshot.businessId,snapshot.storeId,generation.id];
  for(const report of snapshot.reports)await client.query(
    `insert into mc.financial_daily_generation_inputs(business_id,store_id,generation_id,source_kind,report_version_id,report_normalization_id)
     values($1,$2,$3,'report',$4,$5)`,[...args,report.report_version_id,report.normalization_id]);
  for(const coverage of snapshot.emptyWeeks)await client.query(
    `insert into mc.financial_daily_generation_inputs(business_id,store_id,generation_id,source_kind,financial_week_coverage_id,empty_confirmation_job_id)
     values($1,$2,$3,'empty_week',$4,$5)`,[...args,coverage.id,coverage.empty_confirmed_by_job_id]);
  for(const cost of snapshot.costs)await client.query(
    `insert into mc.financial_daily_generation_inputs(business_id,store_id,generation_id,source_kind,cost_version_id) values($1,$2,$3,'cost',$4)`,[...args,cost.id]);
  for(const expense of snapshot.expenses)await client.query(
    `insert into mc.financial_daily_generation_inputs(business_id,store_id,generation_id,source_kind,expense_version_id) values($1,$2,$3,'expense',$4)`,[...args,expense.id]);
  for(const tax of snapshot.taxSettings)await client.query(
    `insert into mc.financial_daily_generation_inputs(business_id,store_id,generation_id,source_kind,tax_setting_version_id) values($1,$2,$3,'tax',$4)`,[...args,tax.id]);
  await client.query(`insert into mc.financial_daily_generation_inputs(business_id,store_id,generation_id,source_kind,selection_id) values($1,$2,$3,'selection',$4)`,[...args,snapshot.selection.id]);
  for(const productId of snapshot.products)await client.query(
    `insert into mc.financial_daily_generation_products(business_id,store_id,generation_id,product_id,selected) values($1,$2,$3,$4,true)`,[...args,productId]);
  const selectedDays=daily.days.filter(day=>day.accountingDate>=context.affected_from&&day.accountingDate<=context.affected_to);
  for(const day of selectedDays){
    await client.query(`insert into mc.financial_daily_days(business_id,store_id,generation_id,accounting_date,coverage_complete,quality,tax_usable,
      store_profit_before_tax,selected_profit_before_tax,available_profit_before_tax) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [...args,day.accountingDate,day.coverageComplete,day.quality,day.taxUsable,day.storeLevelResultBeforeTax,day.selectedProductsResultBeforeTax,day.availableResultBeforeTax]);
    for(const reason of day.missingReasons)await client.query(
      `insert into mc.financial_daily_reasons(business_id,store_id,generation_id,accounting_date,reason_code,scope,severity)
       values($1,$2,$3,$4,$5,'store',$6)`,[...args,day.accountingDate,reason,day.quality==='unavailable'?'unavailable':'partial']);
  }
  const selectedLines=daily.lines.filter(line=>line.accountingDate>=context.affected_from&&line.accountingDate<=context.affected_to);
  for(const line of selectedLines){
    const saved=(await client.query(`insert into mc.financial_daily_results(business_id,store_id,generation_id,accounting_date,category_code,scope,
      product_id,variant_id,amount_signed,quality) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [...args,line.accountingDate,line.categoryCode,line.scopeCode==='store'?'store':'selected_products',line.productId,line.variantId,line.amountSigned,
        daily.days.find(day=>day.accountingDate===line.accountingDate)?.quality??'unavailable'])).rows[0];
    for(const evidence of line.evidence){
      if(evidence.sourceType==='financial_component')await client.query(
        `insert into mc.financial_daily_evidence(business_id,store_id,generation_id,daily_result_id,financial_component_id,contribution_amount)
         values($1,$2,$3,$4,$5,$6)`,[...args,saved.id,evidence.sourceId,evidence.contributionAmount]);
      else if(evidence.sourceType==='return_expense_reversal')await client.query(
        `insert into mc.financial_daily_evidence(business_id,store_id,generation_id,daily_result_id,report_row_id,source_operation_version_id,operation_link_id,contribution_amount)
         values($1,$2,$3,$4,$5,$6,$7,$8)`,[...args,saved.id,evidence.reportRowId,evidence.sourceId,evidence.operationLinkId,evidence.contributionAmount]);
      else if(['sale_cost','return_cost'].includes(evidence.sourceType))await client.query(
        `insert into mc.financial_daily_evidence(business_id,store_id,generation_id,daily_result_id,cost_version_id,source_operation_version_id,operation_link_id,quantity,contribution_amount)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[...args,saved.id,evidence.costVersionId,evidence.sourceId,evidence.operationLinkId??null,evidence.quantity,evidence.contributionAmount]);
      else if(evidence.sourceType==='expense_version')await client.query(
        `insert into mc.financial_daily_evidence(business_id,store_id,generation_id,daily_result_id,expense_version_id,contribution_amount)
         values($1,$2,$3,$4,$5,$6)`,[...args,saved.id,evidence.sourceId,evidence.contributionAmount]);
      else throw new Error('financial_daily_evidence_invalid');
    }
  }
  for(const fact of daily.taxFacts.filter(row=>row.accountingDate>=context.affected_from&&row.accountingDate<=context.affected_to)){
    const saved=(await client.query(`insert into mc.financial_daily_tax_facts(business_id,store_id,generation_id,accounting_date,product_id,
      tax_setting_version_id,tax_base_unrounded,tax_numerator_unrounded,tax_rate_fraction) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [...args,fact.accountingDate,fact.productId,fact.taxSettingVersionId,fact.taxableBase,fact.numerator,fact.rateFraction])).rows[0];
    for(const evidence of fact.evidence)await client.query(
      `insert into mc.financial_daily_tax_evidence(business_id,store_id,generation_id,tax_fact_id,financial_component_id,contribution_amount)
       values($1,$2,$3,$4,$5,$6)`,[...args,saved.id,evidence.sourceId,evidence.contributionAmount]);
  }
}

async function compareLegacy(client,context,generation,daily){
  const legacy=(await client.query(
    `select p.id as publication_id,r.id as run_id,f.id as period_result_id,f.period_start::text,f.period_end::text,f.quality,f.missing_reasons,f.totals
       from mc.publications p join mc.calculation_runs r on r.id=p.run_id join mc.financial_period_results f on f.run_id=r.id
      where p.business_id=$1 and p.store_id=$2 and f.period_start>=$3 and f.period_end<=$4
      order by p.created_at,f.period_start`,[context.business_id,context.store_id,context.affected_from,context.affected_to])).rows;
  for(const period of legacy){
    const comparison=compareDailyGenerationToLegacy(daily,period);
    const status=comparison.daily.totals===null&&comparison.daily.missingReasons.includes('report_coverage_incomplete')?'not_comparable':comparison.status;
    await client.query(`insert into mc.financial_daily_shadow_comparisons(business_id,store_id,generation_id,publication_id,period_result_id,
      legacy_run_id,period_start,period_end,status,compared_metrics,difference_details) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)`,
      [context.business_id,context.store_id,generation.id,period.publication_id,period.period_result_id,period.run_id,period.period_start,period.period_end,status,
        JSON.stringify({quality:true,missingReasons:true,totals:true}),JSON.stringify({mismatches:comparison.mismatches,daily:comparison.daily})]);
  }
}

export function createFinancialDailyGenerationRepository({pool,publicationRepository=createFinancialDailyPublicationRepository()}){
  if(!pool?.connect)throw new TypeError('pool is required');
  if(!publicationRepository?.publish)throw new TypeError('daily publication repository is required');
  async function build(jobId,leaseToken,workerId){
    return transaction(pool,async client=>{
      const context=await establish(client,jobId,leaseToken,workerId);
      if(!context)return{superseded:true};
      if(Number(context.event_generation)<Number(context.watermark_generation))return{superseded:true};
      const snapshot=await loadSnapshot(client,context);
      const daily=fillCoverageGaps(combineDailyFinancialGenerations(calculateFinancialPeriods(snapshot)),context.affected_from,context.affected_to);
      const generation=(await client.query(`select * from mc.start_financial_daily_generation($1,$2,$3,$4,$5,$6,$7)`,
        [jobId,leaseToken,workerId,context.event_generation,snapshot.fingerprint,snapshot.parserMethod.method_version_id,snapshot.method.id])).rows[0];
      if(generation.status!=='building'){
        if(generation.status!=='succeeded')return{superseded:generation.status==='superseded',generationId:generation.id};
        const publication=await publicationRepository.publish(client,{jobId,leaseToken,workerId,generationId:generation.id,eventGeneration:context.event_generation});
        return{superseded:false,generationId:generation.id,publicationId:publication.id,quality:generation.quality};
      }
      await persistGeneration(client,context,snapshot,generation,daily);
      await compareLegacy(client,context,generation,daily);
      const final=(await client.query(`select * from mc.finalize_financial_daily_generation($1,$2,$3,$4,$5,'succeeded',$6,null)`,
        [jobId,leaseToken,workerId,generation.id,context.event_generation,daily.quality])).rows[0];
      if(final.status!=='succeeded')return{superseded:final.status==='superseded',generationId:final.id,quality:final.quality};
      const publication=await publicationRepository.publish(client,{jobId,leaseToken,workerId,generationId:final.id,eventGeneration:context.event_generation});
      return{superseded:false,generationId:final.id,publicationId:publication.id,quality:final.quality};
    });
  }
  return{build};
}
