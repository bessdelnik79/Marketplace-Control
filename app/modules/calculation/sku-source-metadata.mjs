import {parseScale4Money} from '../overview/financial-overview.mjs';
// Report identities and quantities from the exact saved evidence, not current WB state.
export async function loadSkuSourceMetadata(client,{context,model,businessId}){
  const daily=context.publication.source==='daily';
  const groups=[...model.items.flatMap(item=>item.groups),...model.storeLines];
  const refs=groups.flatMap(group=>group.lineRefs.filter(ref=>ref.source===(daily?'daily':'legacy')).map(ref=>({groupKey:group.groupKey,
    id:daily?ref.dailyResultId:ref.resultLineId,owner:daily?ref.generationId:ref.runId,date:ref.accountingDate??null,period:ref.periodResultId??null})));
  if(!refs.length)return;
  const frozen=daily?`exists(select 1 from mc.financial_daily_generation_inputs i where i.business_id=$1 and i.store_id=$2 and i.generation_id=r.owner
      and i.report_version_id=rr.report_version_id and i.report_normalization_id=o.report_normalization_id)`:
    `exists(select 1 from mc.calculation_inputs i where i.business_id=$1 and i.store_id=$2 and i.run_id=r.owner and i.report_version_id=rr.report_version_id)
      and exists(select 1 from mc.calculation_inputs i where i.business_id=$1 and i.store_id=$2 and i.run_id=r.owner and i.report_normalization_id=o.report_normalization_id)`;
  // Keep the correlated ID lookup from being flattened into a date/product join
  // that repeatedly scans operations for every evidence row (OFFSET 0 below).
  const rows=(await client.query(`with sku_source_refs as(select * from jsonb_to_recordset($3::jsonb)
      as r("groupKey" text,id uuid,owner uuid,date date,period uuid))
    select distinct r."groupKey" group_key,p.external_report_id report_id,o.id operation_id,o.operation_type,o.quantity::text,
      l.category_code,l.id line_id,l.amount_signed::text line_amount,e.id evidence_id,e.contribution_amount::text
    from sku_source_refs r join mc.${daily?'financial_daily_results':'result_lines'} l on l.id=r.id and l.${daily?'generation_id':'run_id'}=r.owner
      and l.business_id=$1 and l.store_id=$2 ${daily?'and l.accounting_date=r.date':'and l.financial_period_result_id=r.period'}
    join mc.${daily?'financial_daily_evidence':'result_evidence'} e on e.${daily?'daily_result_id':'result_line_id'}=l.id
      and e.business_id=$1 and e.store_id=$2 ${daily?'and e.generation_id=r.owner':''}
    left join mc.financial_components f on f.id=e.financial_component_id and f.business_id=$1 and f.store_id=$2
    join lateral (select operation.id,operation.operation_type,operation.quantity,operation.accounting_date,operation.product_id,
        operation.state,operation.report_row_id,operation.report_normalization_id
      from mc.operation_versions operation
      where operation.id=coalesce(f.operation_version_id,e.source_operation_version_id) and operation.business_id=$1 and operation.store_id=$2
      offset 0) o on o.accounting_date=l.accounting_date and o.product_id is not distinct from l.product_id and o.state='active'
    join mc.report_rows rr on rr.id=o.report_row_id and rr.business_id=$1 and rr.store_id=$2
      and (e.report_row_id is null or e.report_row_id=rr.id)
    join mc.report_normalizations rn on rn.id=o.report_normalization_id and rn.business_id=$1 and rn.store_id=$2
      and rn.report_version_id=rr.report_version_id and rn.status='succeeded'
    join mc.report_versions rv on rv.id=rr.report_version_id and rv.business_id=$1 and rv.store_id=$2
    join mc.reports p on p.id=rv.report_id and p.business_id=$1 and p.store_id=$2
    ${daily?'join mc.financial_daily_generations owner on owner.id=r.owner and owner.business_id=$1 and owner.store_id=$2':''}
    where ${frozen} ${daily?'and rn.method_version_id=owner.parser_method_version_id':''}
      and (f.id is null or (f.method_version_id=rn.method_version_id and f.category_code=l.category_code
        and f.result_scope_classification=${daily?"case when l.scope='store' then 'store' else 'selected_product' end":'l.result_scope'}
        and round(f.amount_signed,4)=e.contribution_amount))
      and p.external_report_id ~ '^[0-9]{1,40}$'
      and (rr.raw_data->>'reportId' is null or rr.raw_data->>'reportId'=p.external_report_id)`,[businessId,context.storeId,JSON.stringify(refs)])).rows;
  applySkuSourceMetadata(model,rows);
}
export function applySkuSourceMetadata(model,rows){
  const groups=[...model.items.flatMap(item=>item.groups),...model.storeLines];
  const byGroup=new Map(),byLine=new Map();
  for(const row of rows){
    if(!byGroup.has(row.group_key))byGroup.set(row.group_key,[]);
    byGroup.get(row.group_key).push(row);
    const key=JSON.stringify([row.group_key,row.line_id]);
    if(!byLine.has(key))byLine.set(key,new Map());
    byLine.get(key).set(row.evidence_id,row);
  }
  for(const group of groups)group.reportIds=[...new Set((byGroup.get(group.groupKey)??[]).filter(row=>/^\d{1,40}$/.test(row.report_id??'')).map(row=>row.report_id))].sort((a,b)=>a.length-b.length||a.localeCompare(b));
  for(const item of model.items){
    item.reportIds=[...new Set(item.groups.flatMap(group=>group.reportIds))].sort((a,b)=>a.length-b.length||a.localeCompare(b));
    const operations=new Map();
    for(const group of item.groups)for(const row of byGroup.get(group.groupKey)??[])if((row.category_code==='revenue'&&row.operation_type==='sale')||(row.category_code==='revenue_return'&&row.operation_type==='return'))operations.set(row.operation_id,row);
    const count=type=>{let units=0n;for(const row of operations.values())if(row.operation_type===type){const match=/^-?(\d+)(?:\.(\d{1,6}))?$/.exec(row.quantity??'');if(!match)return null;units+=BigInt(match[1]+(match[2]??'').padEnd(6,'0'));}return units>BigInt(Number.MAX_SAFE_INTEGER)?null:Number(units)/1e6;};
    const revenueGroups=item.groups.filter(group=>['revenue','revenue_return'].includes(group.categoryCode));
    const complete=item.quality==='complete'&&operations.size>0&&revenueGroups.every(group=>group.lineRefs.every(ref=>{
      const unique=[...(byLine.get(JSON.stringify([group.groupKey,ref.dailyResultId??ref.resultLineId]))?.values()??[])];
      return unique.length>0&&unique.reduce((total,row)=>total+parseScale4Money(row.contribution_amount),0n)===parseScale4Money(unique[0].line_amount);
    }));
    // An absence of verified evidence is unknown, never a proven zero.
    item.salesCount=complete?count('sale'):null;item.returnsCount=complete?count('return'):null;
  }
}

export function completeSkuWeeks({start,end}){
  const day=86400000,first=new Date(`${start}T00:00:00Z`),last=new Date(`${end}T00:00:00Z`);
  first.setUTCDate(first.getUTCDate()+(8-first.getUTCDay())%7);
  const weeks=[];
  for(let time=first.getTime();time+6*day<=last.getTime();time+=7*day)weeks.push({start:new Date(time).toISOString().slice(0,10),end:new Date(time+6*day).toISOString().slice(0,10)});
  return weeks;
}
