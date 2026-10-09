import { pool as defaultPool } from '../../infrastructure/database/client.mjs';
import {buildSkuPresentation} from './sku-presentation.mjs';
import {loadSkuSourceMetadata,completeSkuWeeks} from './sku-source-metadata.mjs';
import {tariffPublicationAllowed} from '../billing/tariff-access.mjs';
import { aggregateDailyPublicationPeriod, aggregatePublishedPeriodEnvelopes, loadPublishedPeriodEnvelopes } from './calculation.repository.mjs';
import { buildFinancialPeriodOverview, financialResultIncludesStore, validateCalendarPeriod } from '../overview/financial-overview.mjs';
import { buildSituations } from '../overview/situations.mjs';
import { buildPublishedDrilldownModel, paginatePublishedSkuList } from './drilldown.mjs';
import { readContributionPage } from './drilldown-evidence.repository.mjs';
import { readSituationRevenueAbsence } from './situation-absence.repository.mjs';

const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function invalid(code='drilldown_invalid_request'){throw new Error(code);}
function uuid(value){if(typeof value!=='string'||!uuidPattern.test(value))invalid();return value.toLowerCase();}
function request(input){
  if(!input||!['legacy','daily'].includes(input.publicationSource))invalid();
  let period;try{period=validateCalendarPeriod({start:input.periodStart,end:input.periodEnd});}catch{invalid();}
  return{...input,storeId:uuid(input.storeId),publicationId:uuid(input.publicationId),periodStart:period.start,periodEnd:period.end};
}
function safeImage(value,historical){
  if(historical||typeof value!=='string')return null;
  try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&(url.hostname==='wbbasket.ru'||url.hostname.endsWith('.wbbasket.ru'))?url.href:null;}catch{return null;}
}
function unavailable(periodStart,periodEnd,reasons){return{period_start:periodStart,period_end:periodEnd,quality:'unavailable',missing_reasons:reasons,
  totals:null,lines:[],covered_period:null,taxReference:null};}
function publicGroup({lineRefs,reportIds,...group}){return group;}
function publicItem(item){return{...item,groups:item.groups.map(publicGroup)};}
function presentationGroup(group){return {...publicGroup(group),reportIds:group.reportIds??[]};}
function presentationItem(item){return {...publicItem(item),groups:item.groups.map(presentationGroup)};}

async function legacySnapshot(client,businessId,input){
  const publication=(await client.query(`select p.id,p.created_at as published_at,r.id as run_id,r.request_id,
      r.period_start::text,r.period_end::text,r.method_version_id,m.code,m.implementation_version
    from mc.publications p join mc.calculation_runs r on r.id=p.run_id
    join mc.method_versions m on m.id=r.method_version_id
    where p.business_id=$1 and p.store_id=$2 and p.id=$3 and r.status='succeeded'`,
  [businessId,input.storeId,input.publicationId])).rows[0];
  if(!publication)invalid('drilldown_not_found');
  const productIds=(await client.query(`select product_id from mc.calculation_request_products where request_id=$1 order by product_id`,[publication.request_id])).rows.map(row=>row.product_id);
  const periods=await loadPublishedPeriodEnvelopes(client,publication.run_id,input.periodStart,input.periodEnd);
  const exact=periods.find(row=>row.period_start===input.periodStart&&row.period_end===input.periodEnd);
  let envelope=exact??aggregatePublishedPeriodEnvelopes(input.periodStart,input.periodEnd,periods);
  if(!periods.length)envelope=unavailable(input.periodStart,input.periodEnd,['drilldown_source_unsupported','drilldown_period_unavailable']);
  const periodIds=exact?[exact.period_result_id]:periods.map(row=>row.period_result_id);
  const rows=envelope.quality==='unavailable'?[]:(await client.query(`select id,financial_period_result_id,result_scope,product_id,variant_id,
      accounting_date::text,category_code,amount_signed::text,quality from mc.result_lines
    where business_id=$1 and store_id=$2 and run_id=$3 and financial_period_result_id=any($4::uuid[])
      and accounting_date between $5 and $6 order by accounting_date,category_code,id`,
  [businessId,input.storeId,publication.run_id,periodIds,input.periodStart,input.periodEnd])).rows;
  const lines=rows.filter(row=>envelope.taxReference?.usable||row.category_code!=='estimated_usn_tax').map(row=>({
    lineRef:{source:'legacy',runId:publication.run_id,periodResultId:row.financial_period_result_id,resultLineId:row.id},
    scope:row.result_scope,productId:row.product_id,variantId:row.variant_id,accountingDate:row.accounting_date,
    categoryCode:row.category_code,amountSigned:row.amount_signed,quality:row.quality}));
  return{publication:{source:'legacy',id:publication.id,publishedAt:publication.published_at,runId:publication.run_id},
    method:{id:publication.method_version_id,code:publication.code,version:publication.implementation_version},productIds,envelope,lines,taxFacts:[]};
}

async function dailySnapshot(client,businessId,input){
  const publication=(await client.query(`select p.id,p.created_at as published_at,p.generation_id,p.watermark_generation,
      g.result_method_version_id,g.parser_method_version_id,m.code,m.implementation_version
    from mc.financial_daily_publications p join mc.financial_daily_generations g on g.id=p.generation_id
    join mc.method_versions m on m.id=g.result_method_version_id
    where p.business_id=$1 and p.store_id=$2 and p.id=$3 and g.status='succeeded'`,
  [businessId,input.storeId,input.publicationId])).rows[0];
  if(!publication)invalid('drilldown_not_found');
  const days=(await client.query(`select mapped.accounting_date::text,mapped.generation_id,day.coverage_complete,day.quality,day.tax_usable,
      day.store_profit_before_tax::text,day.selected_profit_before_tax::text,day.available_profit_before_tax::text,
      generation.parser_method_version_id,generation.result_method_version_id
    from mc.financial_daily_publication_days mapped
    join mc.financial_daily_days day on day.generation_id=mapped.generation_id and day.accounting_date=mapped.accounting_date
    join mc.financial_daily_generations generation on generation.id=mapped.generation_id
    where mapped.business_id=$1 and mapped.store_id=$2 and mapped.publication_id=$3 and mapped.accounting_date between $4 and $5
    order by mapped.accounting_date`,[businessId,input.storeId,input.publicationId,input.periodStart,input.periodEnd])).rows;
  // Check the whole saved map, including scope on carried generations outside
  // the requested interval. A generation pointer alone is not the publication.
  const generations=(await client.query(`select generation.id,generation.parser_method_version_id,generation.result_method_version_id,
      array(select product_id from mc.financial_daily_generation_products product where product.generation_id=generation.id and selected order by product_id) product_ids
    from mc.financial_daily_generations generation where generation.id=$1 or generation.id in
      (select generation_id from mc.financial_daily_publication_days where publication_id=$2)
    order by generation.id`,[publication.generation_id,input.publicationId])).rows;
  const original=generations.find(row=>row.id===publication.generation_id);
  const productIds=original.product_ids;
  const compatible=generations.every(row=>row.parser_method_version_id===publication.parser_method_version_id&&
    row.result_method_version_id===publication.result_method_version_id&&JSON.stringify(row.product_ids)===JSON.stringify(productIds));
  let envelope,lines=[],taxFacts=[],dailyInputs=null;
  if(!compatible)envelope=unavailable(input.periodStart,input.periodEnd,['drilldown_publication_incompatible']);
  else{
    const args=[businessId,input.storeId,input.publicationId,input.periodStart,input.periodEnd];
    const rows=(await client.query(`select result.id,result.generation_id,result.accounting_date::text,result.scope,
        result.product_id,result.variant_id,result.category_code,result.amount_signed::text,result.quality
      from mc.financial_daily_publication_days mapped join mc.financial_daily_results result
        on result.generation_id=mapped.generation_id and result.accounting_date=mapped.accounting_date
      where mapped.business_id=$1 and mapped.store_id=$2 and mapped.publication_id=$3 and mapped.accounting_date between $4 and $5
      order by result.accounting_date,result.category_code,result.id`,args)).rows;
    const reasons=(await client.query(`select reason.accounting_date::text,reason.reason_code
      from mc.financial_daily_publication_days mapped join mc.financial_daily_reasons reason
        on reason.generation_id=mapped.generation_id and reason.accounting_date=mapped.accounting_date
      where mapped.business_id=$1 and mapped.store_id=$2 and mapped.publication_id=$3 and mapped.accounting_date between $4 and $5
      order by reason.accounting_date,reason.reason_code`,args)).rows;
    const facts=(await client.query(`select fact.id,fact.generation_id,fact.accounting_date::text,fact.product_id,fact.tax_setting_version_id,
        fact.tax_base_unrounded::text,fact.tax_numerator_unrounded::text,fact.tax_rate_fraction::text
      from mc.financial_daily_publication_days mapped join mc.financial_daily_tax_facts fact
        on fact.generation_id=mapped.generation_id and fact.accounting_date=mapped.accounting_date
      where mapped.business_id=$1 and mapped.store_id=$2 and mapped.publication_id=$3 and mapped.accounting_date between $4 and $5
      order by fact.accounting_date,fact.product_id,fact.id`,args)).rows;
    envelope=aggregateDailyPublicationPeriod(input.periodStart,input.periodEnd,{days,lines:rows,reasons,taxFacts:facts});
    dailyInputs={days,lines:rows,reasons,taxFacts:facts};
    if(envelope.quality!=='unavailable'){
      lines=rows.map(row=>({lineRef:{source:'daily',generationId:row.generation_id,accountingDate:row.accounting_date,dailyResultId:row.id},
        scope:row.scope==='store'?'store':'selected_product',productId:row.product_id,variantId:row.variant_id,accountingDate:row.accounting_date,
        categoryCode:row.category_code,amountSigned:row.amount_signed,quality:row.quality}));
      taxFacts=facts.map(row=>({id:row.id,generationId:row.generation_id,accountingDate:row.accounting_date,productId:row.product_id,
        taxSettingVersionId:row.tax_setting_version_id,taxBaseUnrounded:row.tax_base_unrounded,
        taxNumeratorUnrounded:row.tax_numerator_unrounded,taxRateFraction:row.tax_rate_fraction}));
    }
  }
  return{publication:{source:'daily',id:publication.id,publishedAt:publication.published_at,
    dayRefs:days.map(row=>({accountingDate:row.accounting_date,generationId:row.generation_id}))},
    method:{id:publication.result_method_version_id,code:publication.code,version:publication.implementation_version,
      parserMethodVersionId:publication.parser_method_version_id,resultMethodVersionId:publication.result_method_version_id,
      generations:generations.map(row=>({generationId:row.id,parserMethodVersionId:row.parser_method_version_id,resultMethodVersionId:row.result_method_version_id}))},
    productIds,envelope,lines,taxFacts,dailyInputs};
}

async function updateState(client,businessId,input){
  let latest=(await client.query(input.publicationSource==='daily'
    ?`select p.id,p.watermark_generation from mc.financial_daily_current_publications current join mc.financial_daily_publications p on p.id=current.publication_id
      where current.business_id=$1 and current.store_id=$2 and (select count(*) from mc.financial_daily_publication_days
        where publication_id=p.id and accounting_date between $3 and $4)=($4::date-$3::date+1)`
    :`select p.id,p.run_id from mc.publications p where p.business_id=$1 and p.store_id=$2 and p.is_current
      and $3::date<=$4::date`,
  [businessId,input.storeId,input.periodStart,input.periodEnd])).rows[0];
  if(latest&&input.publicationSource==='legacy'){
    const periods=await loadPublishedPeriodEnvelopes(client,latest.run_id,input.periodStart,input.periodEnd);
    const exact=periods.find(row=>row.period_start===input.periodStart&&row.period_end===input.periodEnd);
    if((exact??aggregatePublishedPeriodEnvelopes(input.periodStart,input.periodEnd,periods)).quality==='unavailable')latest=null;
  }
  const job=(await client.query(`select status,last_error_code,updated_at,payload->>'eventGeneration' event_generation
    from mc.jobs where business_id=$1 and store_id=$2 and job_type='financial_dates_recalculate'
    and (payload->>'affectedFrom')::date<=$4 and (payload->>'affectedTo')::date>=$3
    order by (payload->>'eventGeneration')::bigint desc,created_at desc limit 1`,
  [businessId,input.storeId,input.periodStart,input.periodEnd])).rows[0];
  const newer=latest&&latest.id!==input.publicationId?latest.id:null;
  const applied=latest?.watermark_generation!=null&&job?.event_generation!=null&&BigInt(job.event_generation)<=BigInt(latest.watermark_generation);
  const status=!job||applied||job.status==='succeeded'?'current':job.status;
  return{status,publicationId:input.publicationId,availablePublicationId:newer,
    updatedAt:job?.updated_at??null,lastErrorCode:status==='failed'?job.last_error_code??null:null};
}

export function createPublishedDrilldownRepository({pool=defaultPool}={}){
  async function read(userId,raw,action){
    const input=request(raw);uuid(userId);
    const client=await pool.connect();
    try{
      await client.query('begin isolation level repeatable read read only');
      await client.query("select set_config('app.user_id',$1,true)",[userId]);
      const membership=(await client.query(`select business_id,role from mc.memberships where user_id=$1 order by created_at limit 1`,[userId])).rows[0];
      if(!membership||!['owner','editor','viewer'].includes(membership.role))invalid('drilldown_not_found');
      const businessId=membership.business_id;
      await client.query("select set_config('app.business_id',$1,true)",[businessId]);
      if(!(await client.query(`select id from mc.stores where business_id=$1 and id=$2
        and exists(select 1 from mc.active_profile_stores a where a.business_id=$1 and a.store_id=$2)`,[businessId,input.storeId])).rows.length)invalid('drilldown_not_found');
      const snapshot=await(input.publicationSource==='legacy'?legacySnapshot:dailySnapshot)(client,businessId,input);
      const {envelope,productIds,publication,method,lines,taxFacts}=snapshot;
      if(!await tariffPublicationAllowed(client,input.storeId,productIds))invalid('drilldown_not_found');
      const allowed=(await client.query(input.publicationSource==='daily'
        ?'select mc.financial_daily_publication_tariff_allowed($1) allowed'
        :`select mc.financial_tariff_scope_matches($2,array(select product_id from mc.calculation_request_products where request_id=r.request_id order by product_id),q.tariff_scope_token) allowed
          from mc.publications p join mc.calculation_runs r on r.id=p.run_id left join mc.calculation_requests q on q.id=r.request_id where p.id=$1`,
      input.publicationSource==='daily'?[input.publicationId]:[input.publicationId,input.storeId])).rows[0]?.allowed;
      if(allowed!==true)invalid('drilldown_not_found');
      if(envelope.quality==='unavailable'&&!envelope.missing_reasons.includes('drilldown_period_unavailable')&&!envelope.missing_reasons.includes('drilldown_publication_incompatible'))envelope.missing_reasons.push('drilldown_period_unavailable');
      const products=(await client.query(`select id,title,seller_article,wb_article::text,image_url,historical_deleted,status from mc.products
        where business_id=$1 and store_id=$2 and id=any($3::uuid[]) order by id`,[businessId,input.storeId,productIds])).rows.map(row=>({
          productId:row.id,name:row.title,sellerArticle:row.seller_article,wbArticle:row.wb_article,
          imageUrl:safeImage(row.image_url,row.historical_deleted),isHistorical:row.historical_deleted||row.status==='archived'}));
      const context={contractVersion:'p05-drilldown-v1',publication,storeId:input.storeId,period:{start:input.periodStart,end:input.periodEnd},method,
        scope:{type:'selected_products',productIds,includesStoreResult:financialResultIncludesStore(method.version)},
        quality:envelope.quality,missingReasons:envelope.missing_reasons,
        coverage:{requested:{start:input.periodStart,end:input.periodEnd},covered:envelope.covered_period??null,
          complete:envelope.daily_read_complete??(envelope.quality!=='unavailable'&&!envelope.missing_reasons.includes('report_coverage_incomplete'))},
        resultBasis:envelope.quality==='unavailable'?'unavailable':envelope.taxReference?.usable?'after_tax':'before_tax',
        totals:envelope.totals,update:await updateState(client,businessId,input)};
      const overviewEnvelope={...envelope,publication_id:publication.id,method_version:method.version,scope:'selected_products',
        coverage:{productIds},period_start:input.periodStart,period_end:input.periodEnd};
      const model=buildPublishedDrilldownModel({context,envelope:overviewEnvelope,products,lines,taxFacts});
      for(const item of model.items)for(const group of item.groups){
        if(publication.source==='legacy'&&group.categoryCode==='estimated_usn_tax')group.taxBasisAvailable=true;
      }
      const result=await action({client,input,context,model,lines,taxFacts,businessId,overviewEnvelope,snapshot});
      await client.query('commit');return result;
    }catch(error){await client.query('rollback');throw error;}finally{client.release();}
  }
  const readPublishedSkuList=(userId,input)=>read(userId,input,async({client,context,model,input,businessId})=>{
    await loadSkuSourceMetadata(client,{context,model,businessId});
    const page=paginatePublishedSkuList(model,input);
    return{...page,items:page.items.map(publicItem),storeLines:page.storeLines.map(publicGroup),presentation:{...buildSkuPresentation({...model,items:model.items.map(presentationItem)}),storeLines:model.storeLines.map(presentationGroup)}};
  });
  const readPublishedSkuCard=(userId,input)=>{
    uuid(input?.productId);
    return read(userId,input,async({client,context,model,businessId,snapshot:periodSnapshot})=>{
      const item=model.items.find(row=>row.productId===input.productId.toLowerCase());if(!item)invalid('drilldown_not_found');
      await loadSkuSourceMetadata(client,{context,model:{items:[item],storeLines:[]},businessId});
      const presentation=buildSkuPresentation({...model,items:[presentationItem(item)]}).items[0];
      if(input.includeWeekly){
        presentation.weeklyResults=[];
        for(const period of completeSkuWeeks(context.period)){
          const within=row=>row.accounting_date>=period.start&&row.accounting_date<=period.end;
          const snapshot=context.publication.source==='daily'?{...periodSnapshot,
            envelope:periodSnapshot.dailyInputs?aggregateDailyPublicationPeriod(period.start,period.end,Object.fromEntries(Object.entries(periodSnapshot.dailyInputs).map(([key,rows])=>[key,rows.filter(within)]))):unavailable(period.start,period.end,periodSnapshot.envelope.missing_reasons),
            lines:periodSnapshot.lines.filter(row=>row.accountingDate>=period.start&&row.accountingDate<=period.end),
            taxFacts:periodSnapshot.taxFacts.filter(row=>row.accountingDate>=period.start&&row.accountingDate<=period.end)}:
            await legacySnapshot(client,businessId,{...input,periodStart:period.start,periodEnd:period.end});
          const weekContext={...context,period,quality:snapshot.envelope.quality,totals:snapshot.envelope.totals};
          const weekModel=buildPublishedDrilldownModel({context:weekContext,envelope:{...snapshot.envelope,publication_id:context.publication.id,method_version:snapshot.method.version,scope:'selected_products',coverage:{productIds:snapshot.productIds},period_start:period.start,period_end:period.end},products:model.items,lines:snapshot.lines,taxFacts:snapshot.taxFacts});
          const weekItem=buildSkuPresentation(weekModel).items.find(row=>row.productId===item.productId);
          presentation.weeklyResults.push({...period,result:weekModel.reconciliation.status==='mismatch'||weekItem?.metrics.availableResultAfterTax.availability!=='complete'?null:weekItem.metrics.availableResultAfterTax.amount,quality:weekModel.reconciliation.status==='mismatch'?'unavailable':weekItem?.quality??'unavailable'});
        }
      }
      return{context:model.context,item:publicItem(item),presentation,storeLines:model.storeLines.map(publicGroup),reconciliation:model.reconciliation};
    });
  };
  const readSituations=(userId,input,confirmAbsence=false)=>read(userId,input,async({client,model,context,overviewEnvelope})=>{
    const overview=model.reconciliation.status==='mismatch'?{}:buildFinancialPeriodOverview(overviewEnvelope);
    const financial={...overview,status:context.quality==='unavailable'||model.reconciliation.status==='mismatch'?'unavailable':'available',
      scope:context.scope};
    const result=buildSituations(financial,{limit:null});
    if(model.reconciliation.status==='mismatch')result.missingReasons.push('drilldown_reconciliation_mismatch');
    const productFor=id=>{const item=model.items.find(item=>item.productId===id);return item?{
      productId:item.productId,name:item.name,sellerArticle:item.sellerArticle,wbArticle:item.wbArticle,
      imageUrl:item.imageUrl,isHistorical:item.isHistorical}:null;};
    const allGroups=[...model.items.flatMap(item=>item.groups),...model.storeLines];
    const items=result.items.map(item=>{
      const sku=item.kind==='product_loss'?model.items.find(row=>row.productId===item.productId):null;
      const groups=allGroups.filter(group=>item.kind==='product_loss'
        ?group.scope==='selected_product'&&group.productId===item.productId&&group.categoryCode!=='estimated_usn_tax'
        :group.categoryCode==='penalty').map(group=>({...publicGroup(group),product:productFor(group.productId)}));
      const taxGroup=sku?.groups.find(group=>group.categoryCode==='estimated_usn_tax');
      return{...item,...(sku?{metrics:sku.metrics,quality:sku.quality,missingReasons:sku.missingReasons,
        taxGroup:taxGroup?publicGroup(taxGroup):null}:{}),
        product:productFor(item.productId),groups,rule:item.kind==='product_loss'?{
        description:'Сохранённый результат выбранного SKU до налога отрицателен. Правило оценивается только при полном финансовом результате и подтверждённой связи товара.',
        comparison:'less_than_zero',inputs:[{label:'Результат SKU до налога',value:item.metric.value,unit:'RUB'}]
      }:{description:'Знаковое сальдо сохранённых строк штрафов и пени не равно нулю. Обратные операции включены со своим знаком, общие строки магазина учтены отдельно.',
        comparison:'not_equal_zero',inputs:[{label:'Сальдо штрафов и пени',value:item.metric.value,unit:'RUB'}]}};
    });
    if(confirmAbsence){
      const item=items.find(item=>item.id===input.situationId.toLowerCase()&&item.kind==='product_loss');
      if(item&&(!item.groups.some(group=>group.categoryCode==='revenue')||!item.groups.some(group=>group.categoryCode==='revenue_return')))
        item.revenueAbsence=await readSituationRevenueAbsence(client,{context,item,reconciliation:model.reconciliation});
    }
    return{context,...result,items,reconciliation:model.reconciliation};
  });
  const readPublishedSituations=(userId,input)=>readSituations(userId,input);
  const readPublishedSituation=async(userId,input)=>{
    if(typeof input?.situationId!=='string'||!(input.situationId==='penalty'||/^product_loss:[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(input.situationId))){
      if(input?.situationId==='return_growth')invalid('drilldown_not_found');
      invalid();
    }
    const result=await readSituations(userId,input,true);
    const item=result.items.find(item=>item.id===input.situationId.toLowerCase());if(!item)invalid('drilldown_not_found');
    const {items,...state}=result;return{...state,item};
  };
  const readPublishedContributions=(userId,input)=>{
    if(input?.taxBasis!==undefined&&typeof input.taxBasis!=='boolean')invalid();
    if(input?.scope==='store'){if(input.productId!==undefined&&input.productId!==null)invalid();}
    else uuid(input?.productId);
    if(typeof input?.groupKey!=='string'||input.groupKey.length>500)invalid();
    return read(userId,input,async({client,context,model,lines,taxFacts,businessId})=>{
      const item=input.scope==='store'?null:model.items.find(row=>row.productId===input.productId.toLowerCase());
      if(input.scope!=='store'&&!item)invalid('drilldown_not_found');
      const group=(input.scope==='store'?model.storeLines:item.groups).find(row=>row.groupKey===input.groupKey);
      if(!group)invalid('drilldown_not_found');
      const page=await readContributionPage(client,{context,lines,taxFacts,group,lineRef:input.lineRef??null,cursor:input.cursor??null,limit:input.limit??25,taxBasis:input.taxBasis??false});
      const sources=page.items.flatMap(item=>item.source?[item.source,...(item.source.originalSale?[item.source.originalSale]:[])]:[]);
      const variantIds=[...new Set(sources.map(source=>source.variantId).filter(Boolean))];
      if(variantIds.length){
        const variants=(await client.query(`select v.id,v.product_id,v.size_label,v.color_label,v.status,v.historical_report_only,
          coalesce((select jsonb_agg(i.identifier_value order by i.identifier_value) from mc.variant_identifiers i
            where i.business_id=v.business_id and i.store_id=v.store_id and i.variant_id=v.id and i.identifier_type='barcode'),'[]'::jsonb) barcodes
          from mc.variants v where v.business_id=$1 and v.store_id=$2 and v.id=any($3::uuid[])`,
        [businessId,context.storeId,variantIds])).rows;
        for(const source of sources){
          const variant=variants.find(row=>row.id===source.variantId&&row.product_id===source.productId);
          source.variant=variant?{sizeLabel:variant.size_label,colorLabel:variant.color_label,barcodes:variant.barcodes,
            isHistorical:variant.historical_report_only||variant.status!=='active'}:null;
        }
      }
      return{context,group:publicGroup(group),...page,moneyReconciliation:model.reconciliation};
    });
  };
  return{readPublishedSkuList,readPublishedSkuCard,readPublishedContributions,readPublishedSituations,readPublishedSituation};
}

export const {readPublishedSkuList,readPublishedSkuCard,readPublishedContributions,readPublishedSituations,readPublishedSituation}=createPublishedDrilldownRepository();
