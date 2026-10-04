import { createHash } from 'node:crypto';
import { parseScale4Money, formatScale4Money } from '../overview/financial-overview.mjs';

const frozenMissing='drilldown_frozen_source_missing';
const exactMethods=new Set(Array.from({length:8},(_,index)=>`financial-result-v${index+29}`));
function fail(code='drilldown_invalid_request'){throw new Error(code);}
function refKey(ref){return JSON.stringify(ref);}
function decimal(value){return typeof value==='string'&&/^-?\d+(?:\.\d+)?$/.test(value);}
function money(value){return parseScale4Money(value);}
function sameAmount(a,b){return decimal(a)&&decimal(b)&&compareDecimal(a,b)===0;}
function compareDecimal(a,b){
  const scale=Math.max((a.split('.')[1]??'').length,(b.split('.')[1]??'').length);
  const integer=value=>{const negative=value.startsWith('-');const [whole,fraction='']=value.replace(/^-/,'').split('.');return BigInt(whole+fraction.padEnd(scale,'0'))*(negative?-1n:1n);};
  const difference=integer(a)-integer(b);return difference<0n?-1:difference>0n?1:0;
}
function safeRaw(raw){
  const output={};
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return output;
  for(const key of ['reportId','rrdId','nmId'])if(typeof raw[key]==='string'&&/^\d{1,40}$/.test(raw[key]))output[key]=raw[key];
  if(decimal(raw.quantity)&&raw.quantity.length<=40)output.quantity=raw.quantity;
  for(const key of ['dateFrom','dateTo'])if(typeof raw[key]==='string'&&/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(raw[key]))output[key]=raw[key];
  for(const key of ['docTypeName','sellerOperName'])if(typeof raw[key]==='string'&&raw[key].length<=200&&!/[\x00-\x1f]/.test(raw[key]))output[key]=raw[key];
  if(typeof raw.currency==='string'&&/^[A-Z]{3}$/.test(raw.currency))output.currency=raw.currency;
  return output;
}

// Only the exact immutable input IDs are accepted. Legacy inputs store the
// report and normalization in separate rows; daily inputs store the pair.
function frozenSql(source,column,expression){
  const table=source==='legacy'?'calculation_inputs':'financial_daily_generation_inputs';
  const owner=source==='legacy'?'run_id':'generation_id';
  return `exists(select 1 from mc.${table} i where i.${owner}=$1 and i.store_id=$2 and i.${column}=${expression})`;
}
function reportFrozenSql(source){
  return source==='legacy'
    ?`${frozenSql(source,'report_version_id','rr.report_version_id')} and ${frozenSql(source,'report_normalization_id','o.report_normalization_id')}`
    :`exists(select 1 from mc.financial_daily_generation_inputs i where i.generation_id=$1 and i.store_id=$2 and i.report_version_id=rr.report_version_id and i.report_normalization_id=o.report_normalization_id)`;
}
async function operation(client,context,owner,id){
  const source=context.publication.source;
  return (await client.query(`select o.id,o.product_id,o.variant_id,o.operation_type,o.quantity::text,o.state,
    o.accounting_date::text,o.report_row_id,o.report_normalization_id,rr.report_version_id,
    rn.method_version_id,rn.status normalization_status,
    (${reportFrozenSql(source)} and rn.report_version_id=rr.report_version_id) frozen,
    jsonb_build_object('reportId',rr.raw_data->>'reportId','rrdId',rr.raw_data->>'rrdId','nmId',rr.raw_data->>'nmId',
      'docTypeName',rr.raw_data->>'docTypeName','sellerOperName',rr.raw_data->>'sellerOperName',
      'quantity',rr.raw_data->>'quantity','dateFrom',rr.raw_data->>'dateFrom','dateTo',rr.raw_data->>'dateTo','currency',rr.raw_data->>'currency') raw
    from mc.operation_versions o join mc.report_rows rr on rr.id=o.report_row_id and rr.store_id=o.store_id
    join mc.report_normalizations rn on rn.id=o.report_normalization_id and rn.store_id=o.store_id
    where o.id=$3 and o.store_id=$2`,[owner,context.storeId,id])).rows[0];
}
async function methods(client,context,owner){
  const daily=context.publication.source==='daily';
  const row=(await client.query(daily
    ?'select g.parser_method_version_id,g.result_method_version_id,m.implementation_version from mc.financial_daily_generations g join mc.method_versions m on m.id=g.result_method_version_id where g.id=$1 and g.store_id=$2'
    :'select r.method_version_id result_method_version_id,m.implementation_version from mc.calculation_runs r join mc.method_versions m on m.id=r.method_version_id where r.id=$1 and r.store_id=$2',[owner,context.storeId])).rows[0];
  const expected=context.method?.generations?.find(g=>g.generationId===owner)??context.method;
  if(!row||row.result_method_version_id!==(expected?.resultMethodVersionId??expected?.id)
    ||daily&&row.parser_method_version_id!==expected?.parserMethodVersionId)return null;
  return row;
}
function validOperation(o,line,method,{tax=false}={}){
  return o?.frozen===true&&o.state==='active'&&o.normalization_status==='succeeded'
    &&(!method.parser_method_version_id||o.method_version_id===method.parser_method_version_id)
    &&o.accounting_date===line.accountingDate&&o.product_id===(line.productId??null)
    &&(tax||line.variantId==null||o.variant_id===line.variantId);
}
function operationDto(o){return {operationVersionId:o.id,reportRowId:o.report_row_id,reportVersionId:o.report_version_id,
  reportNormalizationId:o.report_normalization_id,accountingDate:o.accounting_date,operationType:o.operation_type,
  productId:o.product_id,variantId:o.variant_id,quantity:o.quantity,raw:safeRaw(o.raw)};}
async function frozenId(client,context,owner,column,id){
  return (await client.query(`select ${frozenSql(context.publication.source,column,'$3::uuid')} frozen`,[owner,context.storeId,id])).rows[0]?.frozen===true;
}
async function returnSale(client,context,owner,o,linkId,method){
  if(!linkId||context.publication.source==='legacy'&&!await frozenId(client,context,owner,'operation_link_id',linkId))return null;
  const link=(await client.query(`select id,from_operation_version_id,to_operation_version_id,link_type,status,method_version_id
    from mc.operation_links where id=$1 and store_id=$2`,[linkId,context.storeId])).rows[0];
  if(!link||link.from_operation_version_id!==o.id||link.status!=='confirmed'||link.link_type!=='return_to_original_sale'
    ||link.method_version_id!==method.result_method_version_id||o.operation_type!=='return')return null;
  const sale=await operation(client,context,owner,link.to_operation_version_id);
  if(!sale?.frozen||sale.state!=='active'||sale.normalization_status!=='succeeded'||sale.operation_type!=='sale'
    ||method.parser_method_version_id&&sale.method_version_id!==method.parser_method_version_id
    ||sale.product_id!==o.product_id||sale.variant_id!==o.variant_id||sale.accounting_date>o.accounting_date
    ||!decimal(o.quantity)||!decimal(sale.quantity)||compareDecimal(o.quantity,'0')>=0||compareDecimal(sale.quantity,'0')<=0
    ||compareDecimal(o.quantity.replace(/^-/,''),sale.quantity)>0)return null;
  return {linkId:link.id,sale};
}
async function componentSource(client,context,owner,e,line,method,{tax=false}={}){
  const f=(await client.query(`select id,operation_version_id,category_code,source_field,amount_signed::text,method_version_id,result_scope_classification,
    round(amount_signed,4)=$3::numeric rounded_matches
    from mc.financial_components where id=$1 and store_id=$2`,[e.financial_component_id,context.storeId,e.contribution_amount])).rows[0];
  if(!f)return null;
  const o=await operation(client,context,owner,f.operation_version_id);
  if(!validOperation(o,line,method,{tax})||f.method_version_id!==o.method_version_id||!decimal(f.amount_signed))return null;
  if(tax){
    if(f.source_field!=='retailAmount'||f.result_scope_classification!=='selected_product'
      ||!['revenue','revenue_return'].includes(f.category_code)||!sameAmount(e.contribution_amount,f.amount_signed)
      ||!(f.category_code==='revenue'&&o.operation_type==='sale'&&compareDecimal(f.amount_signed,'0')>=0
        ||f.category_code==='revenue_return'&&o.operation_type==='return'&&compareDecimal(f.amount_signed,'0')<=0))return null;
  }else if(f.category_code!==line.categoryCode||f.result_scope_classification!==line.scope
    ||compareDecimal(e.contribution_amount,'0')*compareDecimal(f.amount_signed,'0')<0
    ||(exactMethods.has(method.implementation_version)?!f.rounded_matches
      :compareDecimal(e.contribution_amount.replace(/^-/,''),f.amount_signed.replace(/^-/,''))>0))return null;
  return {sourceKind:'financial_component',financialComponentId:f.id,sourceField:f.source_field,sourceAmount:f.amount_signed,...operationDto(o)};
}
async function readSource(client,context,e,line){
  const owner=line.lineRef.runId??line.lineRef.generationId;
  const method=await methods(client,context,owner);
  if(!method)return null;
  const shapes=['financial_component_id','cost_version_id','expense_version_id','tax_computation_id','report_row_id'].filter(key=>e[key]!=null);
  if(shapes.length!==1)return null;
  if(e.financial_component_id){
    if(e.source_operation_version_id||e.operation_link_id||e.quantity)return null;
    return componentSource(client,context,owner,e,line,method);
  }
  if(e.expense_version_id){
    if(e.source_operation_version_id||e.operation_link_id||e.quantity||!await frozenId(client,context,owner,'expense_version_id',e.expense_version_id))return null;
    const v=(await client.query(`select v.id,v.category,v.amount::text,v.period_start::text,v.period_end::text,v.state,v.recognition_method,e.product_id
      from mc.expense_versions v join mc.expenses e on e.id=v.expense_id and e.store_id=v.store_id where v.id=$1 and v.store_id=$2`,[e.expense_version_id,context.storeId])).rows[0];
    if(!v||v.state!=='active'||v.product_id!==(line.productId??null)||v.category!==line.categoryCode
      ||line.accountingDate<v.period_start||line.accountingDate>v.period_end||!['on_date','evenly_over_period'].includes(v.recognition_method)
      ||compareDecimal(e.contribution_amount,'0')>0||compareDecimal(e.contribution_amount.replace(/^-/,''),v.amount)>0)return null;
    return {sourceKind:'expense_version',expenseVersionId:v.id,sourceAmount:v.amount,period:{start:v.period_start,end:v.period_end},recognitionMethod:v.recognition_method};
  }
  if(e.cost_version_id){
    if(line.scope!=='selected_product'||line.categoryCode!=='cost_of_goods'||!decimal(e.quantity)
      ||!await frozenId(client,context,owner,'cost_version_id',e.cost_version_id))return null;
    const v=(await client.query(`select v.id,v.unit_cost::text,c.product_id,c.variant_id,c.effective_from::text,
      (round(-v.unit_cost*$3::numeric,4)=$4::numeric) amount_matches from mc.cost_versions v
      join mc.variant_costs c on c.id=v.cost_id and c.store_id=v.store_id where v.id=$1 and v.store_id=$2`,[e.cost_version_id,context.storeId,e.quantity,e.contribution_amount])).rows[0];
    const o=await operation(client,context,owner,e.source_operation_version_id);
    if(!v||!v.amount_matches||v.product_id!==line.productId||v.variant_id!==line.variantId||!validOperation(o,line,method)||!sameAmount(e.quantity,o.quantity))return null;
    let sale=null;
    if(o.operation_type==='return')sale=await returnSale(client,context,owner,o,e.operation_link_id,method);
    else if(o.operation_type!=='sale'||e.operation_link_id||compareDecimal(e.contribution_amount,'0')>0)return null;
    if(o.operation_type==='return'&&(!sale||compareDecimal(e.contribution_amount,'0')<0)||v.effective_from>(sale?.sale.accounting_date??o.accounting_date))return null;
    return {sourceKind:sale?'return_cost':'sale_cost',costVersionId:v.id,unitCost:v.unit_cost,effectiveFrom:v.effective_from,quantity:e.quantity,...operationDto(o),
      ...(sale?{operationLinkId:sale.linkId,originalSale:operationDto(sale.sale)}:{})};
  }
  if(e.report_row_id){
    if(!['return_wb_expense_reversal','wb_row_rounding_adjustment'].includes(line.categoryCode)||e.quantity)return null;
    const o=await operation(client,context,owner,e.source_operation_version_id);
    if(!validOperation(o,line,method)||o.report_row_id!==e.report_row_id)return null;
    const sale=e.operation_link_id?await returnSale(client,context,owner,o,e.operation_link_id,method):null;
    if(e.operation_link_id&&!sale||line.categoryCode==='return_wb_expense_reversal'&&!sale)return null;
    if(line.categoryCode==='wb_row_rounding_adjustment'){
      if(!exactMethods.has(method.implementation_version)||line.scope!=='selected_product')return null;
      const check=(await client.query(`select mc.expected_wb_row_rounding_adjustment($1::uuid,$2::uuid,$3::uuid)::text expected`,
        [o.id,method.result_method_version_id,e.operation_link_id])).rows[0];
      if(!sameAmount(check?.expected,e.contribution_amount))return null;
    }else{
      const check=(await client.query(`with raw as(select raw_data from mc.report_rows where id=$1 and store_id=$2),
        fields as(select key,case when nullif(raw_data->>key,'') is null then 0::numeric
          when raw_data->>key ~ '^-?[0-9]+([.][0-9]+)?$' then (raw_data->>key)::numeric else null end amount
          from raw cross join unnest(array['acquiringFee','vw','vwNds','ppvzReward','retailAmount','forPay']) key),
        sums as(select sum(amount) filter(where key in('acquiringFee','vw','vwNds','ppvzReward')) reversal,
          max(amount) filter(where key='retailAmount')-max(amount) filter(where key='forPay') control,
          count(*) filter(where amount is null) invalid from fields)
        select round(reversal,$3::int)::text expected,
          (round(reversal,2)=round(control,2) or ($4::boolean and mc.financial_amounts_match(reversal,control))) control_matches,invalid from sums`,
        [o.report_row_id,context.storeId,exactMethods.has(method.implementation_version)?4:2,
          exactMethods.has(method.implementation_version)])).rows[0];
      if(!check?.control_matches||Number(check.invalid)!==0||!sameAmount(check.expected,e.contribution_amount))return null;
    }
    return {sourceKind:line.categoryCode,...operationDto(o),...(sale?{operationLinkId:sale.linkId,originalSale:operationDto(sale.sale)}:{})};
  }
  return readLegacyTax(client,context,owner,e,line,method);
}

async function readLegacyTax(client,context,owner,e,line,method){
  if(context.publication.source!=='legacy'||line.categoryCode!=='estimated_usn_tax'||line.scope!=='selected_product'
    ||e.source_operation_version_id||e.operation_link_id||e.quantity)return null;
  const c=(await client.query(`select id,product_id,method_version_id,taxable_base::text,tax_amount::text,period_start::text,period_end::text
    from mc.tax_computations where id=$1 and run_id=$2 and store_id=$3`,[e.tax_computation_id,owner,context.storeId])).rows[0];
  if(!c||c.product_id!==line.productId||c.method_version_id!==method.result_method_version_id
    ||!sameAmount(e.contribution_amount,formatScale4Money(-money(c.tax_amount))))return null;
  const period=line.lineRef.periodResultId?(await client.query(`select period_start::text,period_end::text from mc.financial_period_results
    where id=$1 and run_id=$2 and store_id=$3`,[line.lineRef.periodResultId,owner,context.storeId])).rows[0]
    :{period_start:context.period.start,period_end:context.period.end};
  if(!period||c.period_start!==period.period_start||c.period_end!==period.period_end||line.accountingDate!==c.period_end)return null;
  const segments=(await client.query(`select s.id,s.tax_setting_version_id,s.segment_start::text,s.segment_end::text,s.taxable_base::text,s.rate_fraction::text,
    v.state,v.regime_code,v.usn_rate_fraction::text,t.effective_from::text,
    (s.segment_start=greatest(t.effective_from,c.period_start) and s.segment_end=least(coalesce(
      (select min(next_setting.effective_from)-1 from mc.calculation_inputs i
        join mc.tax_setting_versions next_version on next_version.id=i.tax_setting_version_id
        join mc.tax_settings next_setting on next_setting.id=next_version.tax_setting_id
        where i.run_id=$3 and i.store_id=$2 and next_setting.effective_from>t.effective_from),c.period_end),c.period_end)) bounds_valid
    from mc.tax_computation_segments s join mc.tax_setting_versions v on v.id=s.tax_setting_version_id
    join mc.tax_settings t on t.id=v.tax_setting_id join mc.tax_computations c on c.id=s.tax_computation_id
    where s.tax_computation_id=$1 and s.store_id=$2 order by s.segment_start,s.id`,[c.id,context.storeId,owner])).rows;
  if(!segments.length)return null;
  const basis=[];
  for(const s of segments){
    if(!await frozenId(client,context,owner,'tax_setting_version_id',s.tax_setting_version_id)||s.state!=='active'||s.regime_code!=='usn_income'
      ||!s.bounds_valid||!sameAmount(s.rate_fraction,s.usn_rate_fraction)||s.effective_from>s.segment_start||s.segment_start<c.period_start||s.segment_end>c.period_end)return null;
    const evidence=(await client.query(`select id,financial_component_id,taxable_contribution::text contribution_amount,recognition_date::text
      from mc.tax_basis_evidence where tax_segment_id=$1 and store_id=$2 order by id`,[s.id,context.storeId])).rows;
    let base=0n;
    for(const b of evidence){
      if(b.recognition_date<s.segment_start||b.recognition_date>s.segment_end)return null;
      const source=await componentSource(client,context,owner,b,{...line,accountingDate:b.recognition_date},method,{tax:true});
      if(!source)return null;base+=money(b.contribution_amount);
      basis.push({id:b.id,segmentId:s.id,basisContributionAmount:b.contribution_amount,source});
    }
    if(base!==money(s.taxable_base))return null;
  }
  const sums=(await client.query(`select sum(taxable_base)::text base,round(sum(taxable_base*rate_fraction),4)::text tax
    from mc.tax_computation_segments where tax_computation_id=$1 and store_id=$2`,[c.id,context.storeId])).rows[0];
  if(!sameAmount(sums.base,c.taxable_base)||!sameAmount(sums.tax,c.tax_amount))return null;
  return {sourceKind:'tax_computation',taxComputationId:c.id,taxAmount:c.tax_amount,taxableBase:c.taxable_base,
    segments:segments.map(s=>({id:s.id,taxSettingVersionId:s.tax_setting_version_id,start:s.segment_start,end:s.segment_end,taxableBase:s.taxable_base,rateFraction:s.rate_fraction})),basisEvidenceCount:basis.length};
}

function binding(context,group,lineRef,taxBasis){return createHash('sha256').update(JSON.stringify([context.publication,context.storeId,context.period,context.method,context.scope,group.groupKey,lineRef,taxBasis])).digest('hex');}
function decodeCursor(cursor,bound){
  if(cursor==null)return null;
  if(typeof cursor!=='string'||cursor.length>1000||!/^[A-Za-z0-9_-]+$/.test(cursor))fail();
  let value;try{value=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}catch{fail();}
  if(!value||Object.keys(value).sort().join(',')!=='binding,id,version'||value.version!==1||typeof value.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.id))fail();
  if(value.binding!==bound)fail('drilldown_cursor_context_mismatch');
  return value.id;
}

export async function readContributionPage(client,{context,lines,taxFacts=[],group,lineRef=null,cursor=null,limit=25,taxBasis=false}){
  if(typeof taxBasis!=='boolean'||!Number.isInteger(limit)||limit<1||limit>100||!context?.publication||!Array.isArray(lines)||!Array.isArray(group?.lineRefs))fail();
  if(taxBasis&&(context.publication.source!=='legacy'||group.categoryCode!=='estimated_usn_tax'))fail();
  const selected=lines.filter(line=>group.lineRefs.some(ref=>refKey(ref)===refKey(line.lineRef)));
  if(selected.some(line=>line.scope!==group.scope||line.productId!==group.productId||line.categoryCode!==group.categoryCode))fail('drilldown_not_found');
  if(lineRef&&!group.lineRefs.some(ref=>refKey(ref)===refKey(lineRef)))fail('drilldown_not_found');
  const tax=group.lineRefs.some(ref=>ref.source==='daily_tax_range');
  const factRefs=tax?group.lineRefs.flatMap(ref=>ref.taxFactRefs??[]):[];
  const facts=tax?taxFacts.filter(f=>f.productId===group.productId&&factRefs.some(ref=>ref.id===f.id&&ref.generationId===f.generationId&&ref.accountingDate===f.accountingDate&&ref.taxSettingVersionId===f.taxSettingVersionId)):[];
  if(tax&&facts.length!==factRefs.length||!tax&&selected.length!==group.lineRefs.length)fail('drilldown_not_found');
  const bound=binding(context,group,lineRef,taxBasis),after=decodeCursor(cursor,bound);
  const source=context.publication.source;
  if(!['legacy','daily'].includes(source))fail();
  for(const line of selected){
    const ref=line.lineRef;
    if(tax&&ref.source==='daily_tax_range')continue;
    if(ref.source!==source||source==='legacy'&&ref.runId!==context.publication.runId
      ||source==='daily'&&!context.publication.dayRefs?.some(day=>day.generationId===ref.generationId&&day.accountingDate===line.accountingDate))fail('drilldown_not_found');
  }
  if(tax&&(source!=='daily'||facts.some(f=>!context.publication.dayRefs?.some(day=>day.generationId===f.generationId&&day.accountingDate===f.accountingDate))))fail('drilldown_not_found');
  const input=selected.map(l=>({id:l.lineRef.resultLineId??l.lineRef.dailyResultId,owner:l.lineRef.runId??l.lineRef.generationId,
    period:l.lineRef.periodResultId??null,date:l.accountingDate}));
  const refs=tax?facts.map(f=>({id:f.id,owner:f.generationId,date:f.accountingDate,setting:f.taxSettingVersionId,base:f.taxBaseUnrounded,numerator:f.taxNumeratorUnrounded,rate:f.taxRateFraction})):input;
  const resultTable=tax?'financial_daily_tax_facts':source==='legacy'?'result_lines':'financial_daily_results';
  const evidenceTable=tax?'financial_daily_tax_evidence':source==='legacy'?'result_evidence':'financial_daily_evidence';
  const ownerColumn=source==='legacy'?'run_id':'generation_id';
  const lineColumn=tax?'tax_fact_id':source==='legacy'?'result_line_id':'daily_result_id';
  const scopeSql=tax?' and l.product_id=$3::uuid and l.tax_setting_version_id=r.setting and l.tax_base_unrounded=r.base::numeric and l.tax_numerator_unrounded=r.numerator::numeric and l.tax_rate_fraction=r.rate::numeric':` and l.${source==='legacy'?'result_scope':'scope'}=$3 and l.product_id is not distinct from $4::uuid and l.category_code=$5`;
  const cte=`with refs as(select * from jsonb_to_recordset($1::jsonb) as r(id uuid,owner uuid,period uuid,date date,setting uuid,base text,numerator text,rate text)),
    selected as(select l.* from mc.${resultTable} l join refs r on l.id=r.id and l.${ownerColumn}=r.owner
      and l.accounting_date=r.date ${source==='legacy'?'and l.financial_period_result_id is not distinct from r.period':''}
      where l.store_id=$2 ${scopeSql}), evidence as(select e.* from mc.${evidenceTable} e join selected l on l.id=e.${lineColumn}
      and e.store_id=l.store_id ${source==='daily'?'and e.generation_id=l.generation_id':''})`;
  const args=[JSON.stringify(refs),context.storeId,source==='daily'&&group.scope==='selected_product'?'selected_products':group.scope,group.productId,group.categoryCode];
  // Keep placeholders identical for both query shapes; tax has no category/scope.
  const parameters=tax?[args[0],args[1],group.productId]:args;
  const pageRefs=lineRef&&!tax?selected.filter(l=>refKey(l.lineRef)===refKey(lineRef)).map(l=>l.lineRef.resultLineId??l.lineRef.dailyResultId):refs.map(r=>r.id);
  const aggregate=(await client.query(`${cte} select count(*) filter(where ${lineColumn}=any($${parameters.length+1}::uuid[]))::int total_items,
    coalesce(sum(contribution_amount),0)::text amount,
    (select count(*)::int from selected) line_count,${tax?'(select coalesce(sum(tax_base_unrounded),0)::text from selected) tax_base,':''}
    (select count(*)::int from selected l where not exists(select 1 from evidence e where e.${lineColumn}=l.id)
      or l.${tax?'tax_base_unrounded':'amount_signed'} is distinct from (select sum(e.contribution_amount) from evidence e where e.${lineColumn}=l.id)
      ${tax?'or l.tax_numerator_unrounded is distinct from round(l.tax_base_unrounded*l.tax_rate_fraction,12)':''}) invalid_lines
    from evidence`,[...parameters,pageRefs])).rows[0];
  const count=Number(aggregate.total_items),actual=aggregate.amount;
  const expected=tax?aggregate.tax_base:group.amountSigned;
  const match=refs.length>0&&Number(aggregate.line_count)===refs.length&&Number(aggregate.invalid_lines)===0&&(tax||sameAmount(actual,expected));
  const modelUnavailable=group.evidenceStatus==='unavailable';
  if(taxBasis)return readLegacyTaxBasisPage(client,{context,selected,group,cte,parameters,pageRefs,bound,after,limit,cursor,lineRef,match,modelUnavailable,expected,actual});
  const start=parameters.length;
  const page=(await client.query(`${cte} select e.*,e.contribution_amount::text from evidence e
    where e.${lineColumn}=any($${start+1}::uuid[]) and ($${start+2}::uuid is null or e.id>$${start+2}::uuid)
    order by e.id limit $${start+3}`,[...parameters,pageRefs,after,limit+1])).rows;
  const items=[];
  for(const e of page.slice(0,limit)){
    if(tax){
      const f=facts.find(f=>f.id===e.tax_fact_id),owner=f.generationId,method=await methods(client,context,owner);
      const setting=(await client.query(`select v.id,v.state,v.regime_code,v.usn_rate_fraction::text,s.effective_from::text,
        not exists(select 1 from mc.financial_daily_generation_inputs i
          join mc.tax_setting_versions next_version on next_version.id=i.tax_setting_version_id
          join mc.tax_settings next_setting on next_setting.id=next_version.tax_setting_id
          where i.generation_id=$2 and i.store_id=$3 and next_setting.effective_from>s.effective_from and next_setting.effective_from<=$4::date) latest_frozen
        from mc.tax_setting_versions v join mc.tax_settings s on s.id=v.tax_setting_id where v.id=$1`,[f.taxSettingVersionId,owner,context.storeId,f.accountingDate])).rows[0];
      const frozen=await frozenId(client,context,owner,'tax_setting_version_id',f.taxSettingVersionId);
      const validated=match&&!modelUnavailable&&method&&setting?.state==='active'&&setting.latest_frozen&&setting.regime_code==='usn_income'&&frozen
        &&setting.effective_from<=f.accountingDate&&sameAmount(setting.usn_rate_fraction,f.taxRateFraction);
      const sourceDto=validated?await componentSource(client,context,owner,e,{productId:f.productId,accountingDate:f.accountingDate,scope:'selected_product'},method,{tax:true}):null;
      items.push({id:e.id,lineRef:{source:'daily_tax_range',productId:f.productId},basisContributionAmount:e.contribution_amount,
        taxFact:{id:f.id,generationId:f.generationId,accountingDate:f.accountingDate,taxSettingVersionId:f.taxSettingVersionId,
          taxBaseUnrounded:f.taxBaseUnrounded,taxNumeratorUnrounded:f.taxNumeratorUnrounded,taxRateFraction:f.taxRateFraction},
        source:sourceDto,evidenceStatus:sourceDto?'matched':'unavailable',missingReasons:sourceDto?[]:[frozenMissing]});
    }else{
      const line=selected.find(l=>(l.lineRef.resultLineId??l.lineRef.dailyResultId)===e[lineColumn]);
      const dto=match&&!modelUnavailable?await readSource(client,context,e,line):null;
      items.push({id:e.id,lineRef:line.lineRef,contributionAmount:e.contribution_amount,source:dto,
        evidenceStatus:dto?'matched':'unavailable',missingReasons:dto?[]:[match?frozenMissing:'drilldown_reconciliation_mismatch']});
    }
  }
  const missingReasons=[...new Set([...(!match?['drilldown_reconciliation_mismatch']:[]),...(modelUnavailable?group.missingReasons??['drilldown_reconciliation_mismatch']:[]),...items.flatMap(i=>i.missingReasons)])];
  const hasMore=page.length>limit;
  return {items,totalItems:count,nextCursor:hasMore?Buffer.from(JSON.stringify({version:1,binding:bound,id:items.at(-1).id})).toString('base64url'):null,
    reconciliation:{status:match?'matched':'mismatch',checks:[{code:tax?'tax_basis_evidence':'group_contributions',expectedAmount:expected,actualAmount:actual,
      scope:'group',status:match?'matched':'mismatch',...(tax?{basis:'taxable_base'}:{})}]},
    evidenceStatus:missingReasons.length?'unavailable':!cursor&&!hasMore&&!lineRef?'matched':'unchecked',missingReasons,sourceValidationScope:'page'};
}

async function readLegacyTaxBasisPage(client,{context,selected,group,cte,parameters,pageRefs,bound,after,limit,cursor,lineRef,match,modelUnavailable,expected,actual}){
  // This is a second view of the same persisted tax lines. Its page unit is
  // basis evidence, while the independent monetary check stays on tax amounts.
  const contributions=(await client.query(`${cte} select e.*,e.contribution_amount::text from evidence e order by e.id`,parameters)).rows;
  const taxSummary=[],verified=new Map();
  for(const e of contributions){
    const line=selected.find(l=>l.lineRef.resultLineId===e.result_line_id);
    const source=match&&!modelUnavailable?await readSource(client,context,e,line):null;
    taxSummary.push({lineRef:line.lineRef,contributionAmount:e.contribution_amount,source,
      evidenceStatus:source?'matched':'unavailable',missingReasons:source?[]:[match?frozenMissing:'drilldown_reconciliation_mismatch']});
    if(source)verified.set(e.id,{source,line});
  }
  const basisCte=`${cte}, basis as(select b.id,e.id result_evidence_id,e.result_line_id,c.id tax_computation_id,s.id segment_id,
    s.tax_setting_version_id,s.segment_start::text,s.segment_end::text,s.taxable_base::text segment_base,s.rate_fraction::text,
    b.recognition_date::text,b.taxable_contribution::text basis_contribution_amount,b.financial_component_id
    from evidence e join selected l on l.id=e.result_line_id
    join mc.tax_computations c on c.id=e.tax_computation_id and c.run_id=l.run_id and c.store_id=l.store_id and c.product_id=l.product_id
    join mc.tax_computation_segments s on s.tax_computation_id=c.id and s.store_id=c.store_id
    join mc.tax_basis_evidence b on b.tax_segment_id=s.id and b.store_id=s.store_id)`;
  const start=parameters.length;
  const total=(await client.query(`${basisCte} select count(*)::int total_items from basis where result_line_id=any($${start+1}::uuid[])`,[...parameters,pageRefs])).rows[0];
  const page=(await client.query(`${basisCte} select * from basis where result_line_id=any($${start+1}::uuid[])
    and ($${start+2}::uuid is null or id>$${start+2}::uuid) order by id limit $${start+3}`,[...parameters,pageRefs,after,limit+1])).rows;
  const items=[];
  for(const b of page.slice(0,limit)){
    const proof=verified.get(b.result_evidence_id),line=selected.find(l=>l.lineRef.resultLineId===b.result_line_id);
    const method=proof?await methods(client,context,line.lineRef.runId):null;
    const source=method?await componentSource(client,context,line.lineRef.runId,
      {financial_component_id:b.financial_component_id,contribution_amount:b.basis_contribution_amount},
      {...line,accountingDate:b.recognition_date},method,{tax:true}):null;
    items.push({id:b.id,lineRef:line.lineRef,basisContributionAmount:b.basis_contribution_amount,
      taxComputationId:proof?b.tax_computation_id:null,
      segment:proof?{id:b.segment_id,taxSettingVersionId:b.tax_setting_version_id,start:b.segment_start,end:b.segment_end,taxableBase:b.segment_base,rateFraction:b.rate_fraction}:null,
      accountingDate:b.recognition_date,source,evidenceStatus:source?'matched':'unavailable',missingReasons:source?[]:[match?frozenMissing:'drilldown_reconciliation_mismatch']});
  }
  const missingReasons=[...new Set([...(!match?['drilldown_reconciliation_mismatch']:[]),...(modelUnavailable?group.missingReasons??['drilldown_reconciliation_mismatch']:[]),
    ...taxSummary.flatMap(item=>item.missingReasons),...items.flatMap(item=>item.missingReasons)])];
  const hasMore=page.length>limit;
  return {items,totalItems:Number(total.total_items),nextCursor:hasMore?Buffer.from(JSON.stringify({version:1,binding:bound,id:items.at(-1).id})).toString('base64url'):null,
    taxSummary,reconciliation:{status:match?'matched':'mismatch',checks:[{code:'group_contributions',expectedAmount:expected,actualAmount:actual,scope:'group',status:match?'matched':'mismatch'}]},
    evidenceStatus:missingReasons.length?'unavailable':!cursor&&!hasMore&&!lineRef?'matched':'unchecked',missingReasons,sourceValidationScope:'page'};
}
