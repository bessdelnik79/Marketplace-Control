import { createHash } from 'node:crypto';
import {
  financialComponentScope, financialParserVersion, financialReportPeriodMatches,
  isResolvedNonProductOperation, normalizeFinancialOperation, stableJson,
  unverifiedFinancialComponents
} from './finance.mjs';
import { reconcileBankPayment } from './bank-reconciliation.mjs';

const safeDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value??''))?String(value):null;
const safeId=value=>/^\d+$/.test(String(value??''))?String(value).replace(/^0+(?=\d)/,''):null;

function contextArgs(jobId,generation,leaseToken,workerId,type){
  return[jobId,generation,leaseToken,workerId,type];
}

async function transaction(pool,action){
  const client=await pool.connect();
  try{await client.query('begin');const result=await action(client);await client.query('commit');return result;}
  catch(error){await client.query('rollback');throw error;}
  finally{client.release();}
}

async function establish(client,jobId,generation,leaseToken,workerId,type){
  return(await client.query(
    'select * from mc.establish_financial_pipeline_context($1,$2,$3,$4,$5)',
    contextArgs(jobId,generation,leaseToken,workerId,type)
  )).rows[0]??null;
}

async function enqueue(client,storeId,type,key,payload,priority=250){
  return(await client.query('select * from mc.enqueue_job($1,$2,$3,$4::jsonb,clock_timestamp(),$5,20)',
    [storeId,type,key,JSON.stringify(payload),priority])).rows[0];
}

async function refreshCoverage(client,coverageId){
  await client.query(
    `update mc.financial_week_coverage wc set
       coverage_status=case
         when wc.inventory_confirmed_at is not null and exists(select 1 from mc.financial_week_inventory x where x.coverage_id=wc.id)
           and not exists(select 1 from mc.financial_week_inventory x where x.coverage_id=wc.id and x.fetch_status<>'accepted') then 'complete'
         when exists(select 1 from mc.financial_week_inventory x where x.coverage_id=wc.id and x.fetch_status in ('received','normalizing')) then 'fetching'
         else 'retry' end,
       freshness_due_at=case when wc.inventory_confirmed_at is not null
         and exists(select 1 from mc.financial_week_inventory x where x.coverage_id=wc.id)
         and not exists(select 1 from mc.financial_week_inventory x where x.coverage_id=wc.id and x.fetch_status<>'accepted') then null else wc.freshness_due_at end,
       next_retry_at=case when exists(select 1 from mc.financial_week_inventory x where x.coverage_id=wc.id and x.fetch_status<>'accepted')
         then clock_timestamp()+interval '15 minutes' else null end,
       updated_at=clock_timestamp()
     where wc.id=$1`,[coverageId]);
}

async function markExistingAccepted(client,{coverageId,externalReportId,inventoryChecksum,versionId,normalizationId}){
  await client.query(
    `update mc.financial_week_inventory set fetch_status='accepted',report_version_id=$2,
       accepted_normalization_id=$3,accepted_inventory_checksum=inventory_checksum,
       accepted_at=clock_timestamp(),last_error_code=null
     where coverage_id=$1 and external_report_id=$4 and inventory_checksum=$5`,
    [coverageId,versionId,normalizationId,externalReportId,inventoryChecksum]);
  await refreshCoverage(client,coverageId);
}

export function createFinancialPipelineRepository({pool}){
  if(!pool?.query||!pool?.connect)throw new TypeError('financial pipeline repository requires pool');

  async function getFetchContext(jobId,generation,leaseToken,workerId){
    return(await pool.query('select * from mc.establish_financial_pipeline_context($1,$2,$3,$4,$5)',
      contextArgs(jobId,generation,leaseToken,workerId,'financial_report_fetch'))).rows[0]??null;
  }

  async function reserveRequestSlot(sellerId,delaySeconds){
    if(!String(sellerId??'').trim())throw new Error('financial_context_mismatch');
    if(!Number.isInteger(delaySeconds)||delaySeconds<65||delaySeconds>75)throw new Error('financial_invalid_rate_delay');
    const key=createHash('sha256').update(`wb:finance:sales-reports:${sellerId}`).digest('hex');
    const row=(await pool.query(
      `insert into mc.wb_api_request_slots(rate_key,next_allowed_at)
       values($1,clock_timestamp()+make_interval(secs=>$2))
       on conflict(rate_key) do update set
         next_allowed_at=greatest(mc.wb_api_request_slots.next_allowed_at,clock_timestamp())+make_interval(secs=>$2),updated_at=clock_timestamp()
       returning next_allowed_at-make_interval(secs=>$2) as scheduled_at,next_allowed_at`,[key,delaySeconds])).rows[0];
    return{scheduledAt:row.scheduled_at,nextAllowedAt:row.next_allowed_at,waitMs:Math.max(0,new Date(row.scheduled_at).getTime()-Date.now())};
  }

  async function fallbackToPeriod(jobId,generation,leaseToken,workerId){
    return(await pool.query('select * from mc.fallback_financial_detail_to_period($1,$2,$3,$4)',
      [jobId,generation,leaseToken,workerId])).rows[0]??null;
  }

  async function persistRaw(jobId,generation,leaseToken,workerId,{documentId,reports,objects=[],...request}){
    if(!Array.isArray(reports)||reports.length>1000)throw new Error('financial_invalid_response');
    return transaction(pool,async client=>{
      const context=await establish(client,jobId,generation,leaseToken,workerId,'financial_report_fetch');
      if(!context)return{superseded:true};
      const payload=context.payload??request;
      const mode=payload.mode,coverageId=String(payload.coverageId??'');
      if(!['by_report_id','period'].includes(mode)||!safeDate(payload.periodStart)||!safeDate(payload.periodEnd)||
          !/^[0-9a-f-]{36}$/i.test(coverageId))throw new Error('financial_invalid_request');
      if(mode==='by_report_id'&&(reports.length!==1||safeId(payload.reportId)!==reports[0]?.externalReportId))throw new Error('financial_detail_report_mismatch');
      const coverage=(await client.query(
        `select id from mc.financial_week_coverage where id=$1 and business_id=$2 and store_id=$3
          and credential_generation=$4 for update`,
        [coverageId,context.business_id,context.store_id,generation])).rows[0];
      if(!coverage)return{superseded:true};
      if(mode==='by_report_id'){
        const inventory=(await client.query(
          `select inventory_checksum from mc.financial_week_inventory
            where coverage_id=$1 and external_report_id=$2 for update`,[coverageId,payload.reportId])).rows[0];
        if(!inventory||inventory.inventory_checksum!==payload.inventoryChecksum)return{superseded:true};
      }
      if(reports.length===0){
        await client.query(`update mc.financial_week_coverage set coverage_status='retry',next_retry_at=clock_timestamp()+interval '15 minutes',
          last_error_code='financial_detail_empty',updated_at=clock_timestamp() where id=$1`,[coverageId]);
        return{empty:true,normalizations:0};
      }
      const documentChecksum=createHash('sha256').update(stableJson(reports.map(r=>({id:r.externalReportId,checksum:r.checksum})))).digest('hex');
      await client.query(
        `insert into mc.source_documents(id,business_id,store_id,origin,document_type,external_document_id,checksum,completeness)
         values($1,$2,$3,'wb_api','weekly_realization',$4,$5,'complete')`,
        [documentId,context.business_id,context.store_id,`financial-job:${jobId}`,documentChecksum]);
      for(const object of objects)await client.query(
        `insert into mc.source_objects(business_id,store_id,document_id,storage_key,part_number,byte_size,checksum,content_type)
         values($1,$2,$3,$4,$5,$6,$7,$8)`,
        [context.business_id,context.store_id,documentId,object.storageKey,object.partNumber,object.byteSize,object.checksum,object.contentType]);
      let queued=0;
      for(const source of reports){
        if(source.periodStart!==safeDate(payload.periodStart)||source.periodEnd!==safeDate(payload.periodEnd))throw new Error('financial_report_period_mismatch');
        let targetInventoryChecksum=payload.inventoryChecksum??null;
        if(mode==='period')targetInventoryChecksum=(await client.query(
          `insert into mc.financial_week_inventory(business_id,store_id,coverage_id,external_report_id,inventory_checksum,period_start,period_end,fetch_status)
           values($1,$2,$3,$4,$5,$6,$7,'pending')
           on conflict(coverage_id,external_report_id) do update set last_seen_at=clock_timestamp()
           returning inventory_checksum`,
          [context.business_id,context.store_id,coverageId,source.externalReportId,source.checksum,source.periodStart,source.periodEnd])).rows[0].inventory_checksum;
        let report=(await client.query(
          `select id,period_start,period_end,current_version_id from mc.reports
            where business_id=$1 and store_id=$2 and report_type='weekly_realization' and external_report_id=$3 for update`,
          [context.business_id,context.store_id,source.externalReportId])).rows[0];
        if(report&&!financialReportPeriodMatches(report,source))throw new Error('financial_report_period_mismatch');
        if(!report)report=(await client.query(
          `insert into mc.reports(business_id,store_id,external_report_id,report_type,period_start,period_end)
           values($1,$2,$3,'weekly_realization',$4,$5) returning id,period_start,period_end,current_version_id`,
          [context.business_id,context.store_id,source.externalReportId,source.periodStart,source.periodEnd])).rows[0];
        const same=(await client.query(
          `select rv.id,rv.status,(
             select rn.id from mc.report_normalizations rn join mc.method_versions m on m.id=rn.method_version_id
              where rn.report_version_id=rv.id and rn.status='succeeded' and m.code='wb_finance_import' and m.implementation_version=$3
              order by rn.normalized_at desc limit 1
           ) as normalization_id from mc.report_versions rv
            where rv.report_id=$1 and rv.checksum=$2 limit 1`,
          [report.id,source.checksum,financialParserVersion])).rows[0];
        if(same?.normalization_id&&same.status==='accepted'&&report.current_version_id===same.id){
          await markExistingAccepted(client,{coverageId,externalReportId:source.externalReportId,inventoryChecksum:targetInventoryChecksum,versionId:same.id,normalizationId:same.normalization_id});
          continue;
        }
        let version=same;
        if(!version){
          const versionNo=(await client.query('select coalesce(max(version_no),0)+1 as n from mc.report_versions where report_id=$1',[report.id])).rows[0].n;
          version=(await client.query(
            `insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version,supersedes_version_id)
             values($1,$2,$3,$4,$5,$6,$7,$8) returning id,status`,
            [context.business_id,context.store_id,report.id,documentId,versionNo,source.checksum,financialParserVersion,report.current_version_id])).rows[0];
          let rowNumber=0;
          for(const row of source.rows)await client.query(
            `insert into mc.report_rows(business_id,store_id,report_version_id,external_row_key,row_number,raw_data,row_checksum)
             values($1,$2,$3,$4,$5,$6::jsonb,$7)`,
            [context.business_id,context.store_id,version.id,row.externalRowKey,++rowNumber,JSON.stringify(row.rawData),row.rowChecksum]);
        }
        let inventoryRow;
        if(mode==='by_report_id')inventoryRow=(await client.query(
          `update mc.financial_week_inventory set fetch_status='received',report_version_id=$2,last_error_code=null,last_seen_at=clock_timestamp()
            where coverage_id=$1 and external_report_id=$3 returning inventory_checksum`,[coverageId,version.id,source.externalReportId])).rows[0];
        else inventoryRow=(await client.query(
          `insert into mc.financial_week_inventory(business_id,store_id,coverage_id,external_report_id,inventory_checksum,period_start,period_end,fetch_status,report_version_id)
           values($1,$2,$3,$4,$5,$6,$7,'received',$8)
           on conflict(coverage_id,external_report_id) do update set fetch_status='received',report_version_id=excluded.report_version_id,last_seen_at=clock_timestamp()
           returning inventory_checksum`,
          [context.business_id,context.store_id,coverageId,source.externalReportId,source.checksum,source.periodStart,source.periodEnd,version.id])).rows[0];
        if(!inventoryRow)throw new Error('financial_inventory_missing');
        await enqueue(client,context.store_id,'financial_report_normalize',
          `financial-report-normalize:${version.id}:${financialParserVersion}:g${generation}:c${coverageId}`,
          {schemaVersion:1,credentialGeneration:generation,coverageId,reportVersionId:version.id,
            inventoryChecksum:inventoryRow.inventory_checksum,expectedCurrentVersionId:report.current_version_id},275);
        queued++;
      }
      await refreshCoverage(client,coverageId);
      return{empty:false,normalizations:queued};
    });
  }

  async function normalize(jobId,leaseToken,workerId){
    let stage='context';
    try{return await transaction(pool,async client=>{
      const context=await establish(client,jobId,null,leaseToken,workerId,'financial_report_normalize');
      if(!context)return{superseded:true};
      const payload=context.payload??{},versionId=String(payload.reportVersionId??''),coverageId=String(payload.coverageId??'');
      // Keep the dispatch row locked for the whole local transaction. If the
      // lease had already expired, the heartbeat fails and every normalization
      // write is rolled back before acceptance.
      await client.query('select (mc.heartbeat_job($1,$2,$3,300)).id',[jobId,leaseToken,workerId]);
      await client.query("select set_config('app.user_id',$1,true)",[context.actor_user_id]);
      stage='source';
      const source=(await client.query(
        `select rv.id,rv.status,rv.document_id,rv.supersedes_version_id,r.id as report_id,r.external_report_id,
                r.period_start::text,r.period_end::text,r.current_version_id
           from mc.report_versions rv join mc.reports r on r.id=rv.report_id
          where rv.business_id=$1 and rv.store_id=$2 and rv.id=$3 for update of r,rv`,
        [context.business_id,context.store_id,versionId])).rows[0];
      if(!source)throw new Error('financial_report_version_missing');
      const inventory=(await client.query(
        `select inventory_checksum,report_version_id from mc.financial_week_inventory
          where coverage_id=$1 and external_report_id=$2 for update`,[coverageId,source.external_report_id])).rows[0];
      if(!inventory||inventory.inventory_checksum!==payload.inventoryChecksum||String(inventory.report_version_id)!==versionId){
        return{superseded:true};
      }
      const method=(await client.query(
        `select id from mc.method_versions where code='wb_finance_import' and implementation_version=$1 order by version_no desc limit 1`,
        [financialParserVersion])).rows[0];
      if(!method)throw new Error('financial_method_missing');
      let normalization=(await client.query(
        `select id from mc.report_normalizations where report_version_id=$1 and method_version_id=$2 and status='succeeded'`,
        [versionId,method.id])).rows[0];
      let insertedRows=0,issues=0;
      if(!normalization){
        stage='operations';
        normalization=(await client.query(
          `insert into mc.report_normalizations(business_id,store_id,report_version_id,method_version_id,normalization_key,status)
           values($1,$2,$3,$4,$5,'succeeded') returning id`,
          [context.business_id,context.store_id,versionId,method.id,`${financialParserVersion}:${versionId}`])).rows[0];
        const rows=(await client.query(
          `select id,external_row_key,raw_data,row_checksum from mc.report_rows where report_version_id=$1 order by row_number,id`,[versionId])).rows;
        for(const row of rows){
          const normalized=normalizeFinancialOperation(row.raw_data);
          if(normalized.accountingDate<source.period_start||normalized.accountingDate>source.period_end)throw new Error('financial_row_period_mismatch');
          let product=null,variant=null;
          if(normalized.wbArticle&&/^\d+$/.test(normalized.wbArticle))product=(await client.query(
            `select id from mc.products where business_id=$1 and store_id=$2 and wb_article=$3::bigint`,
            [context.business_id,context.store_id,normalized.wbArticle])).rows[0]??null;
          if(product&&normalized.variantBarcode)variant=(await client.query(
            `select v.id from mc.variants v join mc.variant_identifiers i on i.business_id=v.business_id and i.store_id=v.store_id and i.variant_id=v.id
              where v.business_id=$1 and v.store_id=$2 and v.product_id=$3 and i.identifier_type='barcode' and i.identifier_value=$4 limit 1`,
            [context.business_id,context.store_id,product.id,normalized.variantBarcode])).rows[0]??null;
          const addIssue=async(code,severity,details)=>{issues++;await client.query(
            `insert into mc.data_issues(business_id,store_id,document_id,report_row_id,report_normalization_id,code,severity,details)
             values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
            [context.business_id,context.store_id,source.document_id,row.id,normalization.id,code,severity,JSON.stringify(details)]);};
          if(normalized.wbArticle&&!product)await addIssue('financial_product_not_in_catalog','warning',{wbArticle:normalized.wbArticle});
          if(product&&normalized.variantBarcode&&!variant)await addIssue('financial_variant_not_matched','warning',{wbArticle:normalized.wbArticle});
          const unverified=unverifiedFinancialComponents(row.raw_data,normalized,Boolean(product));
          if(normalized.operationType==='unclassified'&&!isResolvedNonProductOperation(row.raw_data,normalized,Boolean(product)))await addIssue('financial_operation_unclassified','blocking',{docTypeName:String(row.raw_data.docTypeName??''),sellerOperName:String(row.raw_data.sellerOperName??'')});
          if(unverified.length)await addIssue('financial_components_unverified','blocking',{sourceFields:unverified});
          const sourceKey=`${source.external_report_id}/${row.external_row_key}`;
          let operation=(await client.query(`select id from mc.operations where store_id=$1 and source_code='wb_finance' and source_operation_key=$2`,[context.store_id,sourceKey])).rows[0];
          if(!operation)operation=(await client.query(
            `insert into mc.operations(business_id,store_id,source_code,source_operation_key) values($1,$2,'wb_finance',$3) returning id`,
            [context.business_id,context.store_id,sourceKey])).rows[0];
          const no=(await client.query('select coalesce(max(version_no),0)+1 as n from mc.operation_versions where operation_id=$1',[operation.id])).rows[0].n;
          const operationVersion=(await client.query(
            `insert into mc.operation_versions(business_id,store_id,operation_id,report_row_id,version_no,srid,operation_type,product_id,variant_id,accounting_date,source_occurred_at,quantity,currency,report_normalization_id)
             values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'RUB',$13) returning id`,
            [context.business_id,context.store_id,operation.id,row.id,no,normalized.srid,normalized.operationType,product?.id??null,variant?.id??null,normalized.accountingDate,normalized.sourceOccurredAt,normalized.quantity,normalization.id])).rows[0];
          for(const component of normalized.components)await client.query(
            `insert into mc.financial_components(business_id,store_id,operation_version_id,component_key,category_code,amount_signed,method_version_id,source_field,result_scope_classification)
             values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [context.business_id,context.store_id,operationVersion.id,component.componentKey,component.categoryCode,component.amountSigned,method.id,component.sourceField,financialComponentScope(row.raw_data,normalized,component,Boolean(product))]);
          insertedRows++;
        }
      }
      stage='acceptance';
      if(source.status==='received'){
        await client.query(`update mc.report_versions set status='validated' where id=$1`,[versionId]);
        await client.query(`update mc.report_versions set status='accepted',accepted_at=clock_timestamp() where id=$1`,[versionId]);
      }
      const pointerCurrent=source.current_version_id;
      const expectedCurrent=payload.expectedCurrentVersionId??null;
      if(String(pointerCurrent??'')!==String(expectedCurrent??'')&&String(pointerCurrent??'')!==versionId){
        await client.query(`update mc.financial_week_inventory set fetch_status='retry',last_error_code='financial_version_superseded'
          where coverage_id=$1 and report_version_id=$2`,[coverageId,versionId]);
        await refreshCoverage(client,coverageId);
        return{superseded:true,insertedRows,issues};
      }
      await client.query('update mc.reports set current_version_id=$1 where id=$2',[versionId,source.report_id]);
      await markExistingAccepted(client,{coverageId,externalReportId:source.external_report_id,inventoryChecksum:payload.inventoryChecksum,versionId,normalizationId:normalization.id});

      const summary=(await client.query(
        `select summary_raw_data from mc.financial_week_inventory where coverage_id=$1 and report_version_id=$2 limit 1`,
        [coverageId,versionId])).rows[0]?.summary_raw_data??null;
      const reportRows=(await client.query('select raw_data from mc.report_rows where report_version_id=$1 order by row_number,id',[versionId])).rows;
      stage='reconciliation';
      const reconciliation=reconcileBankPayment({externalReportId:source.external_report_id,periodStart:source.period_start,periodEnd:source.period_end,rows:reportRows.map(row=>({rawData:row.raw_data}))},summary);
      await client.query(
        `insert into mc.reconciliation_checks(business_id,store_id,report_version_id,check_code,expected_amount,actual_amount,status,details)
         values($1,$2,$3,'wb_bank_payment_sum_v1',$4,$5,$6,$7::jsonb)`,
        [context.business_id,context.store_id,versionId,reconciliation.expectedAmount,reconciliation.actualAmount,reconciliation.status,JSON.stringify({reason:reconciliation.reason,source:'durable_pipeline'})]);

      // A newer immutable normalization supersedes only issues that it no
      // longer reproduces. Historical normalizations and their evidence stay
      // intact and queryable.
      await client.query(
        `update mc.data_issues old_issue
            set status='resolved',resolved_at=clock_timestamp(),resolved_by_normalization_id=$1
           from mc.report_rows source_row
          where old_issue.business_id=$2 and old_issue.store_id=$3
            and old_issue.report_row_id=source_row.id
            and source_row.report_version_id=$4 and old_issue.status='open'
            and old_issue.report_normalization_id is distinct from $1
            and not exists(
              select 1 from mc.data_issues current_issue
               where current_issue.report_normalization_id=$1
                 and current_issue.report_row_id=old_issue.report_row_id
                 and current_issue.code=old_issue.code and current_issue.status='open'
            )`,
        [normalization.id,context.business_id,context.store_id,versionId]);

      const eventKey=`report-normalize-job:${jobId}`;
      stage='event';
      await client.query(
        `select id from mc.emit_financial_input_event($1,$2,$3,$4,$5,
           p_source_report_version_id=>$6,p_source_normalization_id=>$7)`,
        [context.store_id,eventKey,pointerCurrent?'report_updated':'report_accepted',source.period_start,source.period_end,versionId,normalization.id]);

      // Method v24 cannot publish a range that mixes older and v24 days. The
      // migration queues every current report for local v12 normalization;
      // the worker that completes the last one emits exactly one full-range
      // cutover event. No WB call is involved.
      if(financialParserVersion==='wb-finance-v12'){
        // Serialize the final readiness check per store. Without this lock two
        // concurrent last normalizations can each miss the other's commit and
        // neither would emit the cutover.
        await client.query(`select id from mc.stores where business_id=$1 and id=$2 for update`,
          [context.business_id,context.store_id]);
        const upgrade=(await client.query(
          `with pointer_range as (
             select min(day.accounting_date) affected_from,max(day.accounting_date) affected_to
               from mc.financial_daily_current_publications pointer
               join mc.financial_daily_publication_days day on day.publication_id=pointer.publication_id
              where pointer.business_id=$1 and pointer.store_id=$2
           ), report_range as (
             select min(report.period_start) affected_from,max(report.period_end) affected_to
               from mc.reports report join mc.report_versions version on version.id=report.current_version_id
              where report.business_id=$1 and report.store_id=$2 and version.status='accepted'
           )
           select coalesce(pointer_range.affected_from,report_range.affected_from)::text affected_from,
                  coalesce(pointer_range.affected_to,report_range.affected_to)::text affected_to,
                  parser.id parser_method_id,result.id result_method_id
             from pointer_range cross join report_range
             join mc.method_versions parser on parser.code='wb_finance_import'
               and parser.implementation_version='wb-finance-v12'
             join mc.method_versions result on result.code='financial_result'
               and result.implementation_version='financial-result-v26'
            where coalesce(pointer_range.affected_from,report_range.affected_from) is not null
              and exists(select 1 from mc.product_selections selection
                where selection.business_id=$1 and selection.store_id=$2 and selection.status='confirmed')
              and not exists(select 1 from mc.financial_input_events prior_upgrade
                where prior_upgrade.business_id=$1 and prior_upgrade.store_id=$2
                   and prior_upgrade.event_key='financial-result-upgrade:v26:store:'||$2)
              and not exists(
                select 1 from mc.reports pending_report
                join mc.report_versions pending_version on pending_version.id=pending_report.current_version_id
                where pending_report.business_id=$1 and pending_report.store_id=$2
                  and pending_version.status='accepted' and not exists(
                    select 1 from mc.report_normalizations ready
                    join mc.method_versions ready_method on ready_method.id=ready.method_version_id
                    where ready.report_version_id=pending_version.id and ready.status='succeeded'
                      and ready_method.implementation_version='wb-finance-v12'
                  )
              )`,[context.business_id,context.store_id])).rows[0];
        if(upgrade){
          await client.query(
            `insert into mc.calculation_invalidations(business_id,store_id,requested_by,reason,invalidated_at)
              values($1,$2,$3,'signed_return_expense_reversal_v25',clock_timestamp())
             on conflict(store_id) do update set requested_by=excluded.requested_by,reason=excluded.reason,
               generation_token=gen_random_uuid(),invalidated_at=excluded.invalidated_at`,
            [context.business_id,context.store_id,context.actor_user_id]);
          await client.query(
            `select id from mc.emit_financial_input_event($1,$2,'parser_method_updated',$3,$4,
               p_source_parser_method_version_id=>$5)`,
            [context.store_id,`financial-parser-upgrade:v12:store:${context.store_id}`,
              upgrade.affected_from,upgrade.affected_to,upgrade.parser_method_id]);
          await client.query(
            `select id from mc.emit_financial_input_event($1,$2,'result_method_updated',$3,$4,
               p_source_result_method_version_id=>$5)`,
            [context.store_id,`financial-result-upgrade:v26:store:${context.store_id}`,
              upgrade.affected_from,upgrade.affected_to,upgrade.result_method_id]);
        }
      }
      return{superseded:false,insertedRows,issues,normalizationId:normalization.id};
    });}catch(error){
      if(/^financial_[a-z0-9_]{1,99}$/.test(String(error?.message??''))||(error?.code&&error.code!=='P0001'))throw error;
      const wrapped=new Error(`financial_normalize_${stage}_failed`);
      wrapped.cause=error;
      throw wrapped;
    }
  }

  async function recordFailure(jobId,generation,leaseToken,workerId,jobType,errorCode,terminal=false){
    if(!['financial_report_fetch','financial_report_normalize'].includes(jobType)||!/^financial_[a-z0-9_]{1,99}$/.test(errorCode))return;
    return transaction(pool,async client=>{
      const context=await establish(client,jobId,jobType==='financial_report_fetch'?generation:null,leaseToken,workerId,jobType);
      if(!context)return;
      const payload=context.payload??{},coverageId=String(payload.coverageId??'');
      if(!/^[0-9a-f-]{36}$/i.test(coverageId))return;
      if(jobType==='financial_report_normalize')await client.query(
        `update mc.financial_week_inventory set fetch_status=$3,last_error_code=$4
          where coverage_id=$1 and report_version_id=$2`,
        [coverageId,payload.reportVersionId,terminal?'failed':'retry',errorCode]);
      else if(payload.mode==='by_report_id')await client.query(
        `update mc.financial_week_inventory set fetch_status=$3,last_error_code=$4
          where coverage_id=$1 and external_report_id=$2`,
        [coverageId,payload.reportId,terminal?'failed':'retry',errorCode]);
      await client.query(
        `update mc.financial_week_coverage set coverage_status=$2,last_error_code=$3,
           next_retry_at=case when $2='retry' then clock_timestamp()+interval '15 minutes' else null end,updated_at=clock_timestamp()
          where id=$1`,[coverageId,terminal?'partial':'retry',errorCode]);
    });
  }

  return{getFetchContext,reserveRequestSlot,fallbackToPeriod,persistRaw,normalize,recordFailure};
}
