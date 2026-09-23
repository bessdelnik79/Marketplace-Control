import { pool, withOwnedBusinessContext } from '../../infrastructure/database/client.mjs';
import { financialParserVersion } from '../reports/finance.mjs';
import { calculateFinancialResult, createInputFingerprint } from './calculation.mjs';

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
      `select p.id as publication_id,p.created_at as published_at,r.id as run_id,
              r.period_start,r.period_end,r.quality,r.missing_reasons,
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
    return{...publication,lines};
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
         left join lateral (
           select n.id from mc.report_normalizations n join mc.method_versions m on m.id=n.method_version_id
            where n.report_version_id=rv.id and n.status='succeeded' and m.implementation_version=$3
            order by m.version_no desc limit 1
         ) rn on true
        where r.business_id=$1 and r.store_id=$2
        order by r.period_start,r.external_report_id`,[businessId,storeId,financialParserVersion]
    )).rows;
    const normalized=reports.filter(row=>row.normalization_id);
    if(!normalized.length)throw new Error('calculation_financial_inputs_missing');
    const periodStart=reports[0].period_start,periodEnd=reports.reduce((value,row)=>row.period_end>value?row.period_end:value,reports[0].period_end);
    const costs=(await client.query(
      `select v.id from mc.variant_costs c join mc.cost_versions v on v.id=c.current_version_id
        where c.business_id=$1 and c.store_id=$2 and c.product_id=any($3::uuid[]) order by v.id`,[businessId,storeId,products]
    )).rows.map(row=>row.id);
    const expenses=(await client.query(
      `select v.id from mc.expenses e join mc.expense_versions v on v.id=e.current_version_id
        where e.business_id=$1 and e.store_id=$2 and v.state='active' and v.period_end>=$3 and v.period_start<=$4
          and (e.product_id is null or e.product_id=any($5::uuid[])) order by v.id`,[businessId,storeId,periodStart,periodEnd,products]
    )).rows.map(row=>row.id);
    const taxes=(await client.query(
      `select v.id from mc.tax_settings s join mc.tax_setting_versions v on v.id=s.current_version_id
        where s.business_id=$1 and s.effective_from<=$2 and v.state='active' order by s.effective_from,v.id`,[businessId,periodEnd]
    )).rows.map(row=>row.id);
    const method=(await client.query(`select id,implementation_version from mc.method_versions where code='financial_result' and version_no=1`)).rows[0];
    if(!method)throw new Error('calculation_method_missing');
    const fingerprint=createInputFingerprint({resultMethodVersion:`${method.id}:${method.implementation_version}`,selectedProductIds:products,reportVersionIds:normalized.map(row=>row.report_version_id),reportNormalizationIds:normalized.map(row=>row.normalization_id),costVersionIds:costs,expenseVersionIds:expenses,taxSettingVersionIds:taxes,periodStart,periodEnd});
    const current=(await client.query(`select id,input_fingerprint,status from mc.calculation_requests where business_id=$1 and store_id=$2 and is_latest for update`,[businessId,storeId])).rows[0];
    if(current?.input_fingerprint===fingerprint)return{id:current.id,status:current.status,changed:false};
    if(current)await client.query(`update mc.calculation_requests set is_latest=false,status='superseded',updated_at=now() where id=$1`,[current.id]);
    const generation=(await client.query(`select coalesce(max(generation_no),0)+1 as n from mc.calculation_requests where store_id=$1`,[storeId])).rows[0].n;
    const request=(await client.query(
      `insert into mc.calculation_requests(business_id,store_id,generation_no,selection_id,method_version_id,period_start,period_end,input_fingerprint)
       values($1,$2,$3,$4,$5,$6,$7,$8) returning id,status`,[businessId,storeId,generation,selection.id,method.id,periodStart,periodEnd,fingerprint]
    )).rows[0];
    for(const productId of products)await client.query(`insert into mc.calculation_request_products(business_id,store_id,request_id,product_id) values($1,$2,$3,$4)`,[businessId,storeId,request.id,productId]);
    for(const normalizationId of normalized.map(row=>row.normalization_id))await client.query(`insert into mc.calculation_request_inputs(business_id,store_id,request_id,report_normalization_id) values($1,$2,$3,$4)`,[businessId,storeId,request.id,normalizationId]);
    for(const costId of costs)await client.query(`insert into mc.calculation_request_inputs(business_id,store_id,request_id,cost_version_id) values($1,$2,$3,$4)`,[businessId,storeId,request.id,costId]);
    for(const expenseId of expenses)await client.query(`insert into mc.calculation_request_inputs(business_id,store_id,request_id,expense_version_id) values($1,$2,$3,$4)`,[businessId,storeId,request.id,expenseId]);
    for(const taxId of taxes)await client.query(`insert into mc.calculation_request_inputs(business_id,store_id,request_id,tax_setting_version_id) values($1,$2,$3,$4)`,[businessId,storeId,request.id,taxId]);
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
      `insert into mc.calculation_inputs(business_id,store_id,run_id,report_normalization_id,cost_version_id,expense_version_id,tax_setting_version_id)
       values($1,$2,$3,$4,$5,$6,$7)`,[businessId,request.store_id,run.id,input.report_normalization_id,input.cost_version_id,input.expense_version_id,input.tax_setting_version_id]
    );
    const selected=(await client.query(`select product_id from mc.calculation_request_products where request_id=$1 order by product_id`,[request.id])).rows.map(row=>row.product_id);
    const normalizationIds=inputs.map(row=>row.report_normalization_id).filter(Boolean);
    const components=(await client.query(
      `select f.id,f.category_code,f.amount_signed::text,f.result_scope_classification,o.product_id,o.variant_id,o.accounting_date::text,o.state
         from mc.operation_versions o join mc.financial_components f on f.operation_version_id=o.id
        where o.report_normalization_id=any($1::uuid[]) order by f.id`,[normalizationIds]
    )).rows.map(row=>({id:row.id,categoryCode:row.category_code,amountSigned:row.amount_signed,productId:row.product_id,variantId:row.variant_id,accountingDate:row.accounting_date,state:row.state,classificationStatus:['revenue','revenue_return'].includes(row.category_code)?'confirmed':'unclassified',scopeCode:row.result_scope_classification}));
    const operations=(await client.query(
      `select id,operation_type,product_id,variant_id,accounting_date::text,quantity::text,state
         from mc.operation_versions where report_normalization_id=any($1::uuid[]) and operation_type in ('sale','return') order by id`,[normalizationIds]
    )).rows.map(row=>({id:row.id,operationType:row.operation_type,productId:row.product_id,variantId:row.variant_id,accountingDate:row.accounting_date,quantity:row.quantity,state:row.state,scopeCode:'selected_product'}));
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
    const tax=taxIds.length?(await client.query(
      `select v.regime_code,v.usn_rate_fraction::text,v.vat_mode
         from mc.tax_setting_versions v join mc.tax_settings s on s.id=v.tax_setting_id
        where v.id=any($1::uuid[]) and s.effective_from<=$2
        order by s.effective_from desc,v.version_no desc limit 1`,[taxIds,request.period_end]
    )).rows[0]:null;
    const currentReportCount=Number((await client.query(`select count(*)::int as n from mc.reports where business_id=$1 and store_id=$2 and current_version_id is not null`,[businessId,request.store_id])).rows[0].n);
    const result=calculateFinancialResult({periodStart:request.period_start,periodEnd:request.period_end,selectedProductIds:selected,financialComponents:components,operations,costVersions:costs,expenses,taxSetting:tax?{regimeCode:tax.regime_code,usnRateFraction:tax.usn_rate_fraction,vatMode:tax.vat_mode}:null,reportCoverageComplete:normalizationIds.length===currentReportCount});
    for(const line of result.lines){
      const saved=(await client.query(
        `insert into mc.result_lines(business_id,store_id,run_id,product_id,variant_id,accounting_date,category_code,amount_signed,quality,result_scope)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,[businessId,request.store_id,run.id,line.productId,line.variantId,line.accountingDate,line.categoryCode,line.amountSigned,result.quality,line.scopeCode]
      )).rows[0];
      for(const evidence of line.evidence){
        if(evidence.sourceType==='financial_component')await client.query(`insert into mc.result_evidence(business_id,store_id,result_line_id,financial_component_id,contribution_amount) values($1,$2,$3,$4,$5)`,[businessId,request.store_id,saved.id,evidence.sourceId,evidence.contributionAmount]);
        else if(evidence.sourceType==='sale_cost')await client.query(`insert into mc.result_evidence(business_id,store_id,result_line_id,cost_version_id,source_operation_version_id,quantity,contribution_amount) values($1,$2,$3,$4,$5,$6,$7)`,[businessId,request.store_id,saved.id,evidence.costVersionId,evidence.sourceId,evidence.quantity,evidence.contributionAmount]);
        else if(evidence.sourceType==='expense_version')await client.query(`insert into mc.result_evidence(business_id,store_id,result_line_id,expense_version_id,contribution_amount) values($1,$2,$3,$4,$5)`,[businessId,request.store_id,saved.id,evidence.sourceId,evidence.contributionAmount]);
      }
    }
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
