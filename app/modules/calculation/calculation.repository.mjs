import { pool, withOwnedBusinessContext } from '../../infrastructure/database/client.mjs';
import { financialParserVersion } from '../reports/finance.mjs';
import { calculateFinancialResult, calculateStoreTaxReference, createInputFingerprint, isVerifiedWbResultComponent } from './calculation.mjs';

const qualityRank={complete:0,partial:1,unavailable:2};

function fixed4(value){
  const match=String(value).match(/^(-?)(\d+)(?:\.(\d{1,4}))?$/);
  if(!match)throw new Error('calculation_invalid_persisted_total');
  const amount=BigInt(match[2])*10000n+BigInt((match[3]??'').padEnd(4,'0'));
  return match[1]? -amount:amount;
}

function formatFixed4(value){
  const sign=value<0n?'-':'';
  const absolute=value<0n?-value:value;
  return `${sign}${absolute/10000n}.${String(absolute%10000n).padStart(4,'0')}`;
}

function aggregatePeriodResults(results){
  const quality=results.reduce((value,row)=>qualityRank[row.quality]>qualityRank[value]?row.quality:value,'complete');
  const missingReasons=[...new Set(results.flatMap(row=>row.missingReasons))];
  if(results.every(row=>row.totals===null))return{quality,missingReasons,totals:null};
  const keys=['selectedProductsResultBeforeTax','storeLevelResultBeforeTax','availableResultBeforeTax','estimatedUsnTax','availableResultAfterTax','netProfit'];
  const totals={};
  for(const key of keys){
    const values=results.map(row=>row.totals?.[key]);
    totals[key]=values.length&&values.every(value=>value!==null&&value!==undefined)
      ?formatFixed4(values.reduce((sum,value)=>sum+fixed4(value),0n)):null;
  }
  return{quality,missingReasons,totals};
}

async function createConfirmedReturnLinks(client,businessId,storeId,normalizationIds,methodId){
  if(!normalizationIds.length)return[];
  const returns=(await client.query(
    `select o.id,o.product_id,o.variant_id,o.accounting_date::text,o.quantity::text,o.srid,
            nullif(btrim(rr.raw_data->>'shkId'),'') as shk_id,
            nullif(btrim(rr.raw_data->>'orderDt'),'') as order_dt
       from mc.operation_versions o join mc.report_rows rr on rr.id=o.report_row_id
      where o.business_id=$1 and o.store_id=$2 and o.report_normalization_id=any($3::uuid[])
        and o.operation_type='return' and o.state='active' and o.quantity<0
        and nullif(btrim(o.srid),'') is not null and nullif(btrim(rr.raw_data->>'shkId'),'') is not null
        and nullif(btrim(rr.raw_data->>'orderDt'),'') is not null order by o.accounting_date,o.id`,
    [businessId,storeId,normalizationIds]
  )).rows;
  for(const returned of returns){
    const existing=(await client.query(`select id from mc.operation_links where from_operation_version_id=$1 and link_type='return_to_original_sale' and method_version_id=$2`,[returned.id,methodId])).rows[0];
    if(existing)continue;
    const candidates=(await client.query(
      `select s.id,s.quantity::text
         from mc.operation_versions s join mc.report_rows rr on rr.id=s.report_row_id
        where s.business_id=$1 and s.store_id=$2 and s.report_normalization_id=any($3::uuid[])
          and s.operation_type='sale' and s.state='active' and s.quantity>0
          and s.product_id=$4 and s.variant_id=$5 and s.accounting_date<$6
          and nullif(btrim(s.srid),'')=$7 and nullif(btrim(rr.raw_data->>'shkId'),'')=$8
          and nullif(btrim(rr.raw_data->>'orderDt'),'')=$9
        order by s.id for update of s`,
      [businessId,storeId,normalizationIds,returned.product_id,returned.variant_id,returned.accounting_date,returned.srid,returned.shk_id,returned.order_dt]
    )).rows;
    if(candidates.length!==1)continue;
    const sale=candidates[0];
    const fits=(await client.query(
      `select coalesce(sum(abs(r.quantity)),0)+abs($3::numeric)<=$4::numeric as fits
         from mc.operation_links l join mc.operation_versions r on r.id=l.from_operation_version_id
        where l.to_operation_version_id=$1 and l.link_type='return_to_original_sale' and l.status='confirmed' and l.method_version_id=$2`,
      [sale.id,methodId,returned.quantity,sale.quantity]
    )).rows[0].fits;
    if(!fits)continue;
    await client.query(
      `insert into mc.operation_links(business_id,store_id,from_operation_version_id,to_operation_version_id,link_type,status,method_version_id,evidence)
       values($1,$2,$3,$4,'return_to_original_sale','confirmed',$5,$6::jsonb)`,
      [businessId,storeId,returned.id,sale.id,methodId,JSON.stringify({matcher:'srid_shkId_orderDt_product_variant_v1',srid:returned.srid,shkId:returned.shk_id,orderDt:returned.order_dt})]
    );
  }
  return (await client.query(
    `select l.id from mc.operation_links l join mc.operation_versions r on r.id=l.from_operation_version_id
      where l.business_id=$1 and l.store_id=$2 and l.method_version_id=$3 and l.status='confirmed'
        and r.report_normalization_id=any($4::uuid[]) order by l.id`,[businessId,storeId,methodId,normalizationIds]
  )).rows.map(row=>row.id);
}

export async function getFinancialCalculationState(userId,storeId){
  return withOwnedBusinessContext(userId,async(client,businessId)=>(await client.query(
    `select q.id as request_id,q.status as request_status,q.period_start,q.period_end,
            q.last_error_code,q.requested_at,q.updated_at,
            p.id as publication_id,p.created_at as published_at,
            r.id as run_id,r.quality,r.missing_reasons,r.finished_at,
            m.implementation_version as method_version,
            (p.id is not null and r.request_id=q.id) as publication_is_latest
       from mc.calculation_requests q
       left join lateral (
         select p.id,p.run_id,p.created_at from mc.publications p
          where p.business_id=q.business_id and p.store_id=q.store_id and p.is_current
          order by p.created_at desc limit 1
       ) p on true
       left join mc.calculation_runs r on r.id=p.run_id
       left join mc.method_versions m on m.id=r.method_version_id
      where q.business_id=$1 and q.store_id=$2 and q.is_latest`,[businessId,storeId]
  )).rows[0]??null);
}

export async function listFinancialCalculationInvalidations(){
  return (await pool.query(`select * from mc.list_calculation_invalidations()`)).rows;
}

export async function getFinancialCalculationInvalidation(userId,storeId){
  return withOwnedBusinessContext(userId,async(client,businessId)=>(await client.query(
    `select generation_token from mc.calculation_invalidations where business_id=$1 and store_id=$2`,[businessId,storeId]
  )).rows[0]??null);
}

export async function acknowledgeFinancialCalculationInvalidation(userId,storeId,generationToken){
  if(!generationToken)return false;
  return (await pool.query(
    `select mc.ack_calculation_invalidation($1,$2,$3) as acknowledged`,[userId,storeId,generationToken]
  )).rows[0]?.acknowledged===true;
}

export async function getCurrentFinancialResult(userId,storeId){
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    const publication=(await client.query(
      `select p.id as publication_id,p.created_at as published_at,r.id as run_id,r.request_id,
              r.period_start::text as period_start,r.period_end::text as period_end,r.quality,r.missing_reasons,
              m.code as method_code,m.implementation_version as method_version
         from mc.publications p join mc.calculation_runs r on r.id=p.run_id
         join mc.method_versions m on m.id=r.method_version_id
        where p.business_id=$1 and p.store_id=$2 and p.is_current
        order by p.created_at desc limit 1`,[businessId,storeId]
    )).rows[0];
    if(!publication)return null;
    const lines=(await client.query(
      `select result_scope,product_id,variant_id,accounting_date,category_code,
              amount_signed::text,quality
         from mc.result_lines where run_id=$1
        order by accounting_date,result_scope,product_id nulls last,variant_id nulls last,category_code,id`,[publication.run_id]
    )).rows;
    if(['financial-result-v4','financial-result-v5'].includes(publication.method_version)){
      const computations=(await client.query(`select id,product_id,taxable_base::text,tax_amount::text from mc.tax_computations where run_id=$1 order by product_id`,[publication.run_id])).rows;
      const taxTotals=(await client.query(`select coalesce(sum(taxable_base),0)::text as taxable_base,coalesce(sum(tax_amount),0)::text as tax_amount from mc.tax_computations where run_id=$1`,[publication.run_id])).rows[0];
      const segments=(await client.query(`select s.tax_computation_id,c.product_id,s.tax_setting_version_id,s.segment_start::text,s.segment_end::text,s.taxable_base::text,s.rate_fraction::text
        from mc.tax_computation_segments s join mc.tax_computations c on c.id=s.tax_computation_id where c.run_id=$1 order by c.product_id,s.segment_start`,[publication.run_id])).rows;
      const missingReasons=publication.missing_reasons.filter(reason=>reason.startsWith('tax_')||reason==='vat_method_unsupported'||reason==='report_coverage_incomplete');
      const usable=computations.length>0&&!missingReasons.some(reason=>['tax_setting_missing','tax_method_unsupported','tax_source_unverified','tax_source_unlinked','tax_base_missing','tax_base_negative_unverified','report_coverage_incomplete'].includes(reason));
      const estimatedTax=usable?taxTotals.tax_amount:null;
      return{...publication,lines,taxReference:{scope:'selected_products',method:'seller_defined_usn_income_selected_line1_estimate',quality:missingReasons.length?'partial':'complete',missingReasons,usable,includedInResult:usable,
        taxableBase:usable?taxTotals.taxable_base:null,estimatedTax,
        products:computations.map(row=>({productId:row.product_id,taxableBase:row.taxable_base,estimatedTax:row.tax_amount})),
        segments:segments.map(row=>({productId:row.product_id,taxComputationId:row.tax_computation_id,taxSettingVersionId:row.tax_setting_version_id,segmentStart:row.segment_start,segmentEnd:row.segment_end,taxableBase:row.taxable_base,rateFraction:row.rate_fraction}))}};
    }
    if (publication.method_version !== 'financial-result-v3') return{...publication,lines,taxReference:null};
    const selectedProductIds=(await client.query(
      `select product_id from mc.calculation_request_products where request_id=$1 order by product_id`,[publication.request_id]
    )).rows.map(row=>row.product_id);
    const sourceRows=(await client.query(
      `select o.id,o.product_id,o.accounting_date::text,rr.raw_data->>'retailAmount' as retail_amount,
              rr.raw_data->>'docTypeName' as doc_type_name,rr.raw_data->>'sellerOperName' as seller_oper_name,o.state
         from mc.calculation_inputs i join mc.operation_versions o on o.report_normalization_id=i.report_normalization_id
         join mc.report_rows rr on rr.id=o.report_row_id
        where i.run_id=$1 and i.report_normalization_id is not null order by o.id`,[publication.run_id]
    )).rows.map(row=>({id:row.id,productId:row.product_id,accountingDate:row.accounting_date,retailAmount:row.retail_amount,docTypeName:row.doc_type_name,sellerOperName:row.seller_oper_name,state:row.state}));
    const taxSettings=(await client.query(
      `select v.id,s.effective_from::text,v.regime_code,v.usn_rate_fraction::text
         from mc.calculation_inputs i join mc.tax_setting_versions v on v.id=i.tax_setting_version_id
         join mc.tax_settings s on s.id=v.tax_setting_id
        where i.run_id=$1 and i.tax_setting_version_id is not null order by s.effective_from,v.id`,[publication.run_id]
    )).rows.map(row=>({id:row.id,effectiveFrom:row.effective_from,regimeCode:row.regime_code,usnRateFraction:row.usn_rate_fraction}));
    const reportCoverageComplete=!publication.missing_reasons.includes('report_coverage_incomplete');
    const taxReference=calculateStoreTaxReference({periodStart:publication.period_start,periodEnd:publication.period_end,selectedProductIds,sourceRows,taxSettings,reportCoverageComplete});
    return{...publication,lines,taxReference};
  });
}

export async function getPublishedFinancialPeriod(userId,storeId,periodStart,periodEnd){
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    const period=(await client.query(
      `select p.id as publication_id,p.created_at as published_at,r.id as run_id,r.request_id,
              pr.id as period_result_id,pr.period_start::text,pr.period_end::text,pr.quality,pr.missing_reasons,pr.totals,
              m.code as method_code,m.implementation_version as method_version
         from mc.publications p join mc.calculation_runs r on r.id=p.run_id
         join mc.method_versions m on m.id=r.method_version_id
         join mc.financial_period_results pr on pr.run_id=r.id
        where p.business_id=$1 and p.store_id=$2 and p.is_current and pr.period_start=$3 and pr.period_end=$4
        order by p.created_at desc limit 1`,[businessId,storeId,periodStart,periodEnd]
    )).rows[0];
    if(!period)return null;
    const lines=(await client.query(
      `select result_scope,product_id,variant_id,accounting_date::text,category_code,amount_signed::text,quality
         from mc.result_lines where financial_period_result_id=$1
        order by accounting_date,result_scope,product_id nulls last,variant_id nulls last,category_code,id`,[period.period_result_id]
    )).rows;
    const computations=(await client.query(
      `select id,product_id,taxable_base::text,tax_amount::text from mc.tax_computations
        where run_id=$1 and period_start=$2 and period_end=$3 order by product_id`,[period.run_id,period.period_start,period.period_end]
    )).rows;
    const taxTotals=(await client.query(
      `select coalesce(sum(taxable_base),0)::text as taxable_base,coalesce(sum(tax_amount),0)::text as tax_amount
         from mc.tax_computations where run_id=$1 and period_start=$2 and period_end=$3`,[period.run_id,period.period_start,period.period_end]
    )).rows[0];
    const segments=(await client.query(
      `select s.tax_computation_id,c.product_id,s.tax_setting_version_id,s.segment_start::text,s.segment_end::text,s.taxable_base::text,s.rate_fraction::text
         from mc.tax_computation_segments s join mc.tax_computations c on c.id=s.tax_computation_id
        where c.run_id=$1 and c.period_start=$2 and c.period_end=$3 order by c.product_id,s.segment_start`,[period.run_id,period.period_start,period.period_end]
    )).rows;
    const taxReasons=period.missing_reasons.filter(reason=>reason.startsWith('tax_')||reason==='vat_method_unsupported'||reason==='report_coverage_incomplete');
    const usable=computations.length>0&&!taxReasons.some(reason=>['tax_setting_missing','tax_method_unsupported','tax_source_unverified','tax_source_unlinked','tax_base_missing','tax_base_negative_unverified','report_coverage_incomplete'].includes(reason));
    return{...period,lines,taxReference:{scope:'selected_products',method:'seller_defined_usn_income_selected_line1_estimate',quality:taxReasons.length?'partial':'complete',missingReasons:taxReasons,usable,includedInResult:usable,
      taxableBase:usable?taxTotals.taxable_base:null,estimatedTax:usable?taxTotals.tax_amount:null,
      products:computations.map(row=>({productId:row.product_id,taxableBase:row.taxable_base,estimatedTax:row.tax_amount})),
      segments:segments.map(row=>({productId:row.product_id,taxComputationId:row.tax_computation_id,taxSettingVersionId:row.tax_setting_version_id,segmentStart:row.segment_start,segmentEnd:row.segment_end,taxableBase:row.taxable_base,rateFraction:row.rate_fraction}))}};
  });
}

export async function prepareFinancialCalculation(userId,storeId){
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    const store=(await client.query(`select id from mc.stores where business_id=$1 and id=$2 and status='active' for update`,[businessId,storeId])).rows[0];
    if(!store)throw new Error('calculation_store_unavailable');
    const selection=(await client.query(`select id from mc.product_selections where business_id=$1 and store_id=$2 and status='confirmed'`,[businessId,storeId])).rows[0];
    if(!selection)throw new Error('calculation_selection_missing');
    const products=(await client.query(`select product_id from mc.product_selection_items where selection_id=$1 order by product_id`,[selection.id])).rows.map(row=>row.product_id);
    const reports=(await client.query(
      `select r.id as report_id,rv.id as report_version_id,r.period_start::text,r.period_end::text,rn.id as normalization_id
         from mc.reports r join mc.report_versions rv on rv.id=r.current_version_id
         join mc.source_documents d on d.id=rv.document_id and d.origin='wb_api'
         left join lateral (
           select n.id from mc.report_normalizations n join mc.method_versions m on m.id=n.method_version_id
            where n.report_version_id=rv.id and n.status='succeeded' and m.implementation_version in ($3,'wb-finance-v3','wb-finance-v2')
            order by case m.implementation_version when $3 then 0 when 'wb-finance-v3' then 1 else 2 end,m.version_no desc limit 1
         ) rn on true
        where r.business_id=$1 and r.store_id=$2 and rv.status='accepted'
        order by r.period_start,r.external_report_id`,[businessId,storeId,financialParserVersion]
    )).rows;
    if(!reports.length)throw new Error('calculation_financial_inputs_missing');
    const normalized=reports.filter(row=>row.normalization_id);
    if(!normalized.length)throw new Error('calculation_financial_inputs_missing');
    const periodStart=reports[0].period_start,periodEnd=reports.reduce((value,row)=>row.period_end>value?row.period_end:value,reports[0].period_end);
    const costs=(await client.query(
      `select v.id from mc.variant_costs c join mc.cost_versions v on v.id=c.current_version_id
        where c.business_id=$1 and c.store_id=$2 and c.product_id=any($3::uuid[]) and c.effective_from<=$4 order by v.id`,[businessId,storeId,products,periodEnd]
    )).rows.map(row=>row.id);
    const expenses=(await client.query(
      `select v.id from mc.expenses e join mc.expense_versions v on v.id=e.current_version_id
        where e.business_id=$1 and e.store_id=$2 and v.state='active' and v.period_end>=$3 and v.period_start<=$4
          and (e.product_id is null or e.product_id=any($5::uuid[])) order by v.id`,[businessId,storeId,periodStart,periodEnd,products]
    )).rows.map(row=>row.id);
    const taxes=(await client.query(
      `select v.id from mc.tax_settings s join mc.tax_setting_versions v on v.id=s.current_version_id
        where s.business_id=$1 and s.effective_from<=$2 order by s.effective_from,v.id`,[businessId,periodEnd]
    )).rows.map(row=>row.id);
    const method=(await client.query(`select id,implementation_version from mc.method_versions where code='financial_result' and version_no=5`)).rows[0];
    if(!method)throw new Error('calculation_method_missing');
    const operationLinks=await createConfirmedReturnLinks(client,businessId,storeId,normalized.map(row=>row.normalization_id),method.id);
    const fingerprint=createInputFingerprint({resultMethodVersion:`${method.id}:${method.implementation_version}`,selectedProductIds:products,reportVersionIds:reports.map(row=>row.report_version_id),reportNormalizationIds:normalized.map(row=>row.normalization_id),costVersionIds:costs,operationLinkIds:operationLinks,expenseVersionIds:expenses,taxSettingVersionIds:taxes,periodStart,periodEnd});
    const current=(await client.query(`select id,input_fingerprint,status from mc.calculation_requests where business_id=$1 and store_id=$2 and is_latest for update`,[businessId,storeId])).rows[0];
    if(current?.input_fingerprint===fingerprint)return{id:current.id,status:current.status,changed:false};
    if(current)await client.query(`update mc.calculation_requests set is_latest=false,status='superseded',updated_at=now() where id=$1`,[current.id]);
    const generation=(await client.query(`select coalesce(max(generation_no),0)+1 as n from mc.calculation_requests where store_id=$1`,[storeId])).rows[0].n;
    const request=(await client.query(
      `insert into mc.calculation_requests(business_id,store_id,generation_no,selection_id,method_version_id,period_start,period_end,input_fingerprint)
       values($1,$2,$3,$4,$5,$6,$7,$8) returning id,status`,[businessId,storeId,generation,selection.id,method.id,periodStart,periodEnd,fingerprint]
    )).rows[0];
    for(const productId of products)await client.query(`insert into mc.calculation_request_products(business_id,store_id,request_id,product_id) values($1,$2,$3,$4)`,[businessId,storeId,request.id,productId]);
    for(const reportVersionId of reports.map(row=>row.report_version_id))await client.query(`insert into mc.calculation_request_inputs(business_id,store_id,request_id,report_version_id) values($1,$2,$3,$4)`,[businessId,storeId,request.id,reportVersionId]);
    for(const normalizationId of normalized.map(row=>row.normalization_id))await client.query(`insert into mc.calculation_request_inputs(business_id,store_id,request_id,report_normalization_id) values($1,$2,$3,$4)`,[businessId,storeId,request.id,normalizationId]);
    for(const costId of costs)await client.query(`insert into mc.calculation_request_inputs(business_id,store_id,request_id,cost_version_id) values($1,$2,$3,$4)`,[businessId,storeId,request.id,costId]);
    for(const expenseId of expenses)await client.query(`insert into mc.calculation_request_inputs(business_id,store_id,request_id,expense_version_id) values($1,$2,$3,$4)`,[businessId,storeId,request.id,expenseId]);
    for(const taxId of taxes)await client.query(`insert into mc.calculation_request_inputs(business_id,store_id,request_id,tax_setting_version_id) values($1,$2,$3,$4)`,[businessId,storeId,request.id,taxId]);
    for(const operationLinkId of operationLinks)await client.query(`insert into mc.calculation_request_inputs(business_id,store_id,request_id,operation_link_id) values($1,$2,$3,$4)`,[businessId,storeId,request.id,operationLinkId]);
    return{id:request.id,status:request.status,changed:true};
  });
}

async function executeFinancialCalculation(userId,requestId){
  const outcome=await withOwnedBusinessContext(userId,async(client,businessId)=>{
    const request=(await client.query(`select q.*,q.period_start::text as period_start,q.period_end::text as period_end from mc.calculation_requests q where business_id=$1 and id=$2 and is_latest for update`,[businessId,requestId])).rows[0];
    if(!request)throw new Error('calculation_request_stale');
    if(request.status==='published')return{requestId,changed:false};
    const attemptNo=(await client.query(`select coalesce(max(attempt_no),0)+1 as n from mc.calculation_runs where request_id=$1`,[requestId])).rows[0].n;
    const run=(await client.query(
      `insert into mc.calculation_runs(business_id,store_id,selection_id,method_version_id,period_start,period_end,input_fingerprint,request_id,attempt_no)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,[businessId,request.store_id,request.selection_id,request.method_version_id,request.period_start,request.period_end,request.input_fingerprint,request.id,attemptNo]
    )).rows[0];
    await client.query(`update mc.calculation_requests set status='running',last_error_code=null,updated_at=now() where id=$1`,[request.id]);
    await client.query('savepoint calculation_attempt');
    try{
    const inputs=(await client.query(`select * from mc.calculation_request_inputs where request_id=$1 order by id`,[request.id])).rows;
    for(const input of inputs)await client.query(
      `insert into mc.calculation_inputs(business_id,store_id,run_id,report_version_id,report_normalization_id,cost_version_id,expense_version_id,tax_setting_version_id,operation_link_id)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[businessId,request.store_id,run.id,input.report_version_id,input.report_normalization_id,input.cost_version_id,input.expense_version_id,input.tax_setting_version_id,input.operation_link_id]
    );
    const selected=(await client.query(`select product_id from mc.calculation_request_products where request_id=$1 order by product_id`,[request.id])).rows.map(row=>row.product_id);
    const normalizationIds=inputs.map(row=>row.report_normalization_id).filter(Boolean);
    const components=(await client.query(
      `select f.id,f.category_code,f.source_field,f.amount_signed::text,f.result_scope_classification,
              o.product_id,o.variant_id,o.accounting_date::text,o.state,o.operation_type,
              rr.raw_data->>'docTypeName' as doc_type_name,rr.raw_data->>'sellerOperName' as seller_oper_name,
              rr.raw_data->>f.source_field as raw_value
         from mc.operation_versions o join mc.financial_components f on f.operation_version_id=o.id
         join mc.report_rows rr on rr.id=o.report_row_id
        where o.report_normalization_id=any($1::uuid[]) order by f.id`,[normalizationIds]
    )).rows.map(row=>({id:row.id,categoryCode:row.category_code,sourceField:row.source_field,rawValue:row.raw_value,amountSigned:row.amount_signed,productId:row.product_id,variantId:row.variant_id,accountingDate:row.accounting_date,state:row.state,operationType:row.operation_type,docTypeName:row.doc_type_name,sellerOperName:row.seller_oper_name,classificationStatus:isVerifiedWbResultComponent({categoryCode:row.category_code,sourceField:row.source_field,operationType:row.operation_type,docTypeName:row.doc_type_name,sellerOperName:row.seller_oper_name,rawValue:row.raw_value})?'confirmed':'unclassified',scopeCode:row.result_scope_classification}));
    const operations=(await client.query(
      `select id,report_normalization_id,operation_type,product_id,variant_id,accounting_date::text,quantity::text,state
         from mc.operation_versions where report_normalization_id=any($1::uuid[]) and operation_type in ('sale','return') order by id`,[normalizationIds]
    )).rows.map(row=>({id:row.id,reportNormalizationId:row.report_normalization_id,operationType:row.operation_type,productId:row.product_id,variantId:row.variant_id,accountingDate:row.accounting_date,quantity:row.quantity,state:row.state,scopeCode:'selected_product'}));
    const costIds=inputs.map(row=>row.cost_version_id).filter(Boolean);
    const costs=costIds.length?(await client.query(
      `select v.id,c.variant_id,c.effective_from::text,v.unit_cost::text from mc.cost_versions v join mc.variant_costs c on c.id=v.cost_id where v.id=any($1::uuid[]) order by v.id`,[costIds]
    )).rows.map(row=>({id:row.id,variantId:row.variant_id,effectiveFrom:row.effective_from,unitCost:row.unit_cost})):[];
    const expenseIds=inputs.map(row=>row.expense_version_id).filter(Boolean);
    const expenses=expenseIds.length?(await client.query(
      `select v.id,e.product_id,v.category,v.amount::text,v.period_start::text,v.period_end::text,v.recognition_method,v.state
         from mc.expense_versions v join mc.expenses e on e.id=v.expense_id where v.id=any($1::uuid[]) order by v.id`,[expenseIds]
    )).rows.map(row=>({id:row.id,productId:row.product_id,category:row.category,amount:row.amount,periodStart:row.period_start,periodEnd:row.period_end,recognitionMethod:row.recognition_method,state:row.state,scopeCode:row.product_id?'selected_product':'store'})):[];
    const taxIds=inputs.map(row=>row.tax_setting_version_id).filter(Boolean);
    const taxSettings=taxIds.length?(await client.query(
      `select v.id,s.effective_from::text,v.regime_code,v.usn_rate_fraction::text,v.vat_mode,v.state
         from mc.tax_setting_versions v join mc.tax_settings s on s.id=v.tax_setting_id
        where v.id=any($1::uuid[]) and s.effective_from<=$2
        order by s.effective_from,v.id`,[taxIds,request.period_end]
    )).rows:[];
    const tax=taxSettings.at(-1)??null;
    const linkIds=inputs.map(row=>row.operation_link_id).filter(Boolean);
    const operationLinks=linkIds.length?(await client.query(
      `select id,from_operation_version_id,to_operation_version_id,link_type,status from mc.operation_links where id=any($1::uuid[]) order by id`,[linkIds]
    )).rows.map(row=>({id:row.id,fromOperationVersionId:row.from_operation_version_id,toOperationVersionId:row.to_operation_version_id,linkType:row.link_type,status:row.status})):[];
    const reportVersionIds=inputs.map(row=>row.report_version_id).filter(Boolean);
    const reportPeriods=(await client.query(
      `select r.period_start::text,r.period_end::text,rv.id as report_version_id,n.id as normalization_id
         from mc.report_versions rv join mc.reports r on r.id=rv.report_id
         left join mc.report_normalizations n on n.report_version_id=rv.id and n.id=any($2::uuid[])
        where rv.id=any($1::uuid[]) order by r.period_start,r.period_end,rv.id`,[reportVersionIds,normalizationIds]
    )).rows;
    const periods=[...new Map(reportPeriods.map(row=>[`${row.period_start}/${row.period_end}`,{periodStart:row.period_start,periodEnd:row.period_end,rows:[]}])).values()];
    for(const row of reportPeriods)periods.find(period=>period.periodStart===row.period_start&&period.periodEnd===row.period_end).rows.push(row);
    const periodResults=[];
    for(const period of periods){
      const periodNormalizationIds=period.rows.map(row=>row.normalization_id).filter(Boolean);
      const reportCoverageComplete=periodNormalizationIds.length===period.rows.length;
      const taxReference=calculateStoreTaxReference({periodStart:period.periodStart,periodEnd:period.periodEnd,selectedProductIds:selected,
        sourceRows:components.filter(row=>row.sourceField==='retailAmount').map(row=>({id:row.id,productId:row.productId,accountingDate:row.accountingDate,retailAmount:row.rawValue,docTypeName:row.docTypeName,sellerOperName:row.sellerOperName,state:row.state})),
        taxSettings:taxSettings.map(row=>({id:row.id,effectiveFrom:row.effective_from,regimeCode:row.regime_code,usnRateFraction:row.usn_rate_fraction,vatMode:row.vat_mode,state:row.state})),reportCoverageComplete});
      const result=calculateFinancialResult({periodStart:period.periodStart,periodEnd:period.periodEnd,selectedProductIds:selected,financialComponents:components,operations,operationLinks,costVersions:costs,expenses,
        taxSetting:tax?{regimeCode:tax.regime_code,usnRateFraction:tax.usn_rate_fraction,vatMode:tax.vat_mode,state:tax.state}:null,taxReference,reportCoverageComplete});
      const periodResult=(await client.query(
        `insert into mc.financial_period_results(business_id,store_id,run_id,period_start,period_end,quality,missing_reasons,totals)
         values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) returning id`,[businessId,request.store_id,run.id,period.periodStart,period.periodEnd,result.quality,JSON.stringify(result.missingReasons),result.totals===null?null:JSON.stringify(result.totals)]
      )).rows[0];
      const taxComputationIds=new Map();
      if(taxReference.usable)for(const computation of taxReference.products){
        const saved=(await client.query(`insert into mc.tax_computations(business_id,store_id,run_id,product_id,period_start,period_end,taxable_base,tax_amount,method_version_id)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,[businessId,request.store_id,run.id,computation.productId,period.periodStart,period.periodEnd,computation.taxableBase,computation.estimatedTax,request.method_version_id])).rows[0];
        taxComputationIds.set(String(computation.productId),saved.id);
        for(const segment of taxReference.segments.filter(row=>String(row.productId)===String(computation.productId))){
          const savedSegment=(await client.query(`insert into mc.tax_computation_segments(business_id,store_id,tax_computation_id,tax_setting_version_id,segment_start,segment_end,taxable_base,rate_fraction)
            values($1,$2,$3,$4,$5,$6,$7,$8) returning id`,[businessId,request.store_id,saved.id,segment.taxSettingVersionId,segment.segmentStart,segment.segmentEnd,segment.taxableBase,segment.rateFraction])).rows[0];
          for(const evidence of segment.evidence)await client.query(`insert into mc.tax_basis_evidence(business_id,store_id,tax_segment_id,financial_component_id,taxable_contribution,recognition_date)
            values($1,$2,$3,$4,$5,$6)`,[businessId,request.store_id,savedSegment.id,evidence.sourceId,evidence.contributionAmount,evidence.accountingDate]);
        }
      }
      for(const line of result.lines){
        const saved=(await client.query(
          `insert into mc.result_lines(business_id,store_id,run_id,product_id,variant_id,accounting_date,category_code,amount_signed,quality,result_scope,financial_period_result_id)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,[businessId,request.store_id,run.id,line.productId,line.variantId,line.accountingDate,line.categoryCode,line.amountSigned,result.quality,line.scopeCode,periodResult.id]
        )).rows[0];
        for(const evidence of line.evidence){
          if(evidence.sourceType==='financial_component')await client.query(`insert into mc.result_evidence(business_id,store_id,result_line_id,financial_component_id,contribution_amount) values($1,$2,$3,$4,$5)`,[businessId,request.store_id,saved.id,evidence.sourceId,evidence.contributionAmount]);
          else if(evidence.sourceType==='sale_cost')await client.query(`insert into mc.result_evidence(business_id,store_id,result_line_id,cost_version_id,source_operation_version_id,quantity,contribution_amount) values($1,$2,$3,$4,$5,$6,$7)`,[businessId,request.store_id,saved.id,evidence.costVersionId,evidence.sourceId,evidence.quantity,evidence.contributionAmount]);
          else if(evidence.sourceType==='return_cost')await client.query(`insert into mc.result_evidence(business_id,store_id,result_line_id,cost_version_id,source_operation_version_id,operation_link_id,quantity,contribution_amount) values($1,$2,$3,$4,$5,$6,$7,$8)`,[businessId,request.store_id,saved.id,evidence.costVersionId,evidence.sourceId,evidence.operationLinkId,evidence.quantity,evidence.contributionAmount]);
          else if(evidence.sourceType==='expense_version')await client.query(`insert into mc.result_evidence(business_id,store_id,result_line_id,expense_version_id,contribution_amount) values($1,$2,$3,$4,$5)`,[businessId,request.store_id,saved.id,evidence.sourceId,evidence.contributionAmount]);
          else if(evidence.sourceType==='tax_computation')await client.query(`insert into mc.result_evidence(business_id,store_id,result_line_id,tax_computation_id,contribution_amount) values($1,$2,$3,$4,$5)`,[businessId,request.store_id,saved.id,taxComputationIds.get(String(evidence.productId)),evidence.contributionAmount]);
        }
      }
      periodResults.push(result);
    }
    const result=aggregatePeriodResults(periodResults);
    await client.query(`update mc.calculation_runs set status='succeeded',quality=$2,missing_reasons=$3::jsonb,finished_at=now() where id=$1`,[run.id,result.quality,JSON.stringify(result.missingReasons)]);
    const publication=(await client.query(`select mc.publish_latest_calculation($1) as id`,[run.id])).rows[0];
    return{requestId:request.id,runId:run.id,publicationId:publication.id,quality:result.quality,missingReasons:result.missingReasons,totals:result.totals,changed:true};
    }catch(error){
      const errorCode=String(error?.message??'calculation_failed').slice(0,100);
      await client.query('rollback to savepoint calculation_attempt');
      await client.query(`update mc.calculation_runs set status='failed',quality='unavailable',missing_reasons='[]'::jsonb,finished_at=now() where id=$1`,[run.id]);
      await client.query(`update mc.calculation_requests set status='failed',last_error_code=$2,updated_at=now() where id=$1`,[request.id,errorCode]);
      return{requestId:request.id,runId:run.id,errorCode};
    }
  });
  if(outcome.errorCode)throw new Error(outcome.errorCode);
  return outcome;
}

export async function runFinancialCalculation(userId,storeId){
  const request=await prepareFinancialCalculation(userId,storeId);
  try{return await executeFinancialCalculation(userId,request.id);}catch(error){
    await withOwnedBusinessContext(userId,async(client,businessId)=>client.query(
      `update mc.calculation_requests set status='failed',last_error_code=$3,updated_at=now() where business_id=$1 and id=$2 and is_latest`,[businessId,request.id,String(error?.message??'calculation_failed').slice(0,100)]
    )).catch(()=>{});
    throw error;
  }
}
