import { createHash } from 'node:crypto';
import { withOwnedBusinessContext } from '../../infrastructure/database/client.mjs';
import { financialHistoricalWeekRange, financialParserVersion, financialReportPeriodMatches, normalizeFinancialOperation, stableJson } from './finance.mjs';
import { reconcileBankPayment } from './bank-reconciliation.mjs';

async function recordBankCheck(client, businessId, job, source, versionId, summary, summaryError) {
  if(summary)await client.query(
    `insert into mc.financial_report_summary_versions(business_id,store_id,report_version_id,sync_run_id,checksum,raw_data)
     values($1,$2,$3,$4,$5,$6::jsonb) on conflict(report_version_id,checksum) do nothing`,
    [businessId,job.store_id,versionId,job.run_id,summary.checksum,JSON.stringify(summary.rawData)]
  );
  const result = reconcileBankPayment(source, summary?.rawData);
  const reason = summaryError && !summary ? summaryError : result.reason;
  await client.query(
    `insert into mc.reconciliation_checks(business_id,store_id,report_version_id,check_code,expected_amount,actual_amount,status,details)
     values($1,$2,$3,'wb_bank_payment_sum_v1',$4,$5,$6,$7::jsonb)`,
    [businessId,job.store_id,versionId,result.expectedAmount,result.actualAmount,result.status,JSON.stringify({reason,summaryChecksum:summary?.checksum??null,syncRunId:job.run_id})]
  );
  return result.status;
}

export async function beginFinancialSync(userId,storeId,{force=false,historical=false,initialRange,recentRange}={}){
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    const row=(await client.query(
      `select ss.id as stream_id,ss.next_run_at,ss.last_success_at,ss.cursor,cs.ciphertext,cs.nonce,cs.auth_tag,s.external_account_id as seller_id,
              exists(select 1 from mc.product_selections ps where ps.business_id=s.business_id and ps.store_id=s.id and ps.status='confirmed') as selected
         from mc.stores s
         join mc.connections c on c.business_id=s.business_id and c.store_id=s.id and c.status='active'
         join mc.connection_secrets cs on cs.business_id=c.business_id and cs.connection_id=c.id
         join mc.sync_streams ss on ss.business_id=s.business_id and ss.store_id=s.id and ss.source_type='financial_reports' and ss.status='active'
        where s.business_id=$1 and s.id=$2 and s.status='active'
        for update of ss`,[businessId,storeId]
    )).rows[0];
    if(!row)throw new Error('financial_connection_unavailable');
    if(!row.selected)return {started:false,reason:'selection_required'};
    if(!force&&row.next_run_at&&new Date(row.next_run_at)>new Date())return {started:false,reason:'not_due'};
    const running=(await client.query(`select id,started_at from mc.sync_runs where stream_id=$1 and status='running'`,[row.stream_id])).rows[0];
    if(running&&new Date(running.started_at)>new Date(Date.now()-3*60*60*1000))return {started:false,reason:'running'};
    if(running)await client.query(`update mc.sync_runs set status='failed',finished_at=now(),error_code='financial_interrupted' where id=$1`,[running.id]);
    let range=row.last_success_at?recentRange:initialRange;
    if(historical){
      const earliest=(await client.query(
        `select min(date_from)::text as earliest from mc.coverage_intervals
          where business_id=$1 and store_id=$2 and stream_id=$3 and status='complete'`,
        [businessId,storeId,row.stream_id]
      )).rows[0]?.earliest;
      range=financialHistoricalWeekRange(earliest,recentRange?.dateFrom,row.cursor?.historicalWeekStart);
      if(!range)return {started:false,reason:'no_historical_week'};
    }
    if(!range?.dateFrom||!range?.dateTo)throw new Error('financial_invalid_request');
    const run=(await client.query(
      `insert into mc.sync_runs(business_id,store_id,stream_id,requested_from,requested_to,status,started_at,progress)
       values($1,$2,$3,$4,$5,'running',now(),'{"stage":"loading","pages":0,"rows":0}') returning id`,
      [businessId,storeId,row.stream_id,range.dateFrom,range.dateTo]
    )).rows[0];
    if(!historical)await client.query(`update mc.sync_streams set next_run_at=null where id=$1`,[row.stream_id]);
    return {started:true,historical,business_id:businessId,store_id:storeId,stream_id:row.stream_id,run_id:run.id,date_from:range.dateFrom,date_to:range.dateTo,seller_id:row.seller_id,ciphertext:row.ciphertext,nonce:row.nonce,auth_tag:row.auth_tag};
  });
}

export async function reserveFinancialRequestSlot(userId,job,delaySeconds){
  if(!Number.isInteger(delaySeconds)||delaySeconds<65||delaySeconds>75)throw new Error('financial_invalid_rate_delay');
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    if(businessId!==job.business_id||!job.seller_id)throw new Error('financial_context_mismatch');
    const rateKey=createHash('sha256').update(`wb:finance:sales-reports:${job.seller_id}`).digest('hex');
    const slot=(await client.query(
      `insert into mc.wb_api_request_slots(rate_key,next_allowed_at)
       values($1,clock_timestamp()+make_interval(secs=>$2))
       on conflict(rate_key) do update
         set next_allowed_at=greatest(mc.wb_api_request_slots.next_allowed_at,clock_timestamp())+make_interval(secs=>$2),
             updated_at=clock_timestamp()
       returning next_allowed_at-make_interval(secs=>$2) as scheduled_at,next_allowed_at`,
      [rateKey,delaySeconds]
    )).rows[0];
    return {scheduledAt:slot.scheduled_at,nextAllowedAt:slot.next_allowed_at,waitMs:Math.max(0,new Date(slot.scheduled_at).getTime()-Date.now())};
  });
}

export async function updateFinancialSyncProgress(userId,job,progress){
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    if(businessId!==job.business_id)throw new Error('financial_context_mismatch');
    await client.query(`update mc.sync_runs set progress=$2::jsonb where id=$1 and business_id=$3 and status='running'`,[job.run_id,JSON.stringify(progress),businessId]);
  });
}

export async function completeFinancialSync(userId,job,{documentId,reports,summaries=new Map(),summaryError=null,objects=[]}){
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    if(businessId!==job.business_id)throw new Error('financial_context_mismatch');
    // Match beginFinancialSync lock order so an interrupted run cannot commit after its replacement starts.
    const stream=(await client.query(
      `select id from mc.sync_streams where id=$1 and business_id=$2 and store_id=$3 for update`,
      [job.stream_id,businessId,job.store_id]
    )).rows[0];
    const run=stream&&(await client.query(
      `select status from mc.sync_runs where id=$1 and business_id=$2 and store_id=$3 and stream_id=$4 for update`,
      [job.run_id,businessId,job.store_id,job.stream_id]
    )).rows[0];
    if(run?.status!=='running')throw new Error('financial_sync_superseded');
    const documentChecksum=createHash('sha256').update(stableJson(reports.map(report=>({id:report.externalReportId,checksum:report.checksum})))).digest('hex');
    await client.query(
      `insert into mc.source_documents(id,business_id,store_id,sync_run_id,origin,document_type,external_document_id,checksum,completeness)
       values($1,$2,$3,$4,'wb_api','weekly_realization',$5,$6,'complete')`,
      [documentId,businessId,job.store_id,job.run_id,`financial:${job.date_from}:${job.date_to}:${documentChecksum.slice(0,16)}`,documentChecksum]
    );
    for(const object of objects)await client.query(
      `insert into mc.source_objects(business_id,store_id,document_id,storage_key,part_number,byte_size,checksum,content_type)
       values($1,$2,$3,$4,$5,$6,$7,$8)`,
      [businessId,job.store_id,documentId,object.storageKey,object.partNumber,object.byteSize,object.checksum,object.contentType]
    );
    const method=(await client.query(`select id from mc.method_versions where code='wb_finance_import' and implementation_version=$1 order by version_no desc limit 1`,[financialParserVersion])).rows[0];
    if(!method)throw new Error('financial_method_missing');
    let insertedReports=0,unchangedReports=0,normalizedReports=0,reselectedReports=0,insertedRows=0,issues=0;
    const bankChecks={passed:0,failed:0,not_checkable:0};
    for(const source of reports){
      let report=(await client.query(`select id,period_start,period_end,current_version_id from mc.reports where store_id=$1 and report_type='weekly_realization' and external_report_id=$2`,[job.store_id,source.externalReportId])).rows[0];
      if(report&&!financialReportPeriodMatches(report,source))throw new Error('financial_report_period_mismatch');
      if(!report)report=(await client.query(
        `insert into mc.reports(business_id,store_id,external_report_id,report_type,period_start,period_end)
         values($1,$2,$3,'weekly_realization',$4,$5) returning id,period_start,period_end,current_version_id`,
        [businessId,job.store_id,source.externalReportId,source.periodStart,source.periodEnd]
      )).rows[0];
      const same=(await client.query(`select id,status from mc.report_versions where report_id=$1 and checksum=$2`,[report.id,source.checksum])).rows[0];
      let version,reuseRows=false;
      if(same){
        const existingNormalization=(await client.query(`select id from mc.report_normalizations where report_version_id=$1 and method_version_id=$2`,[same.id,method.id])).rows[0];
        if(existingNormalization){
          if(report.current_version_id===same.id)unchangedReports++;
          else{
            if(same.status!=='accepted')throw new Error('financial_report_version_not_accepted');
            await client.query(`update mc.reports set current_version_id=$1 where id=$2`,[same.id,report.id]);
            reselectedReports++;
          }
          bankChecks[await recordBankCheck(client,businessId,job,source,same.id,summaries.get(source.externalReportId),summaryError)]++;
          continue;
        }
        version=same;reuseRows=true;
      }else{
        const versionNo=(await client.query(`select coalesce(max(version_no),0)+1 as n from mc.report_versions where report_id=$1`,[report.id])).rows[0].n;
        version=(await client.query(
          `insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version)
           values($1,$2,$3,$4,$5,$6,$7) returning id`,
          [businessId,job.store_id,report.id,documentId,versionNo,source.checksum,financialParserVersion]
        )).rows[0];
      }
      const normalization=(await client.query(
        `insert into mc.report_normalizations(business_id,store_id,report_version_id,method_version_id,normalization_key,status)
         values($1,$2,$3,$4,$5,'succeeded') returning id`,
        [businessId,job.store_id,version.id,method.id,`${financialParserVersion}:${version.id}`]
      )).rows[0];
      let rowNumber=0;
      for(const sourceRow of source.rows){
        rowNumber++;
        const reportRow=reuseRows
          ?(await client.query(`select id,row_checksum from mc.report_rows where report_version_id=$1 and external_row_key=$2`,[version.id,sourceRow.externalRowKey])).rows[0]
          :(await client.query(
            `insert into mc.report_rows(business_id,store_id,report_version_id,external_row_key,row_number,raw_data,row_checksum)
             values($1,$2,$3,$4,$5,$6::jsonb,$7) returning id,row_checksum`,
            [businessId,job.store_id,version.id,sourceRow.externalRowKey,rowNumber,JSON.stringify(sourceRow.rawData),sourceRow.rowChecksum]
          )).rows[0];
        if(!reportRow||reportRow.row_checksum!==sourceRow.rowChecksum)throw new Error('financial_duplicate_row_conflict');
        const normalized=normalizeFinancialOperation(sourceRow.rawData);
        let product=null,variant=null;
        if(normalized.wbArticle&&/^\d+$/.test(normalized.wbArticle))product=(await client.query(
          `select id from mc.products where business_id=$1 and store_id=$2 and wb_article=$3::bigint`,
          [businessId,job.store_id,normalized.wbArticle]
        )).rows[0]??null;
        if(product&&normalized.variantBarcode)variant=(await client.query(
          `select v.id from mc.variants v join mc.variant_identifiers i on i.business_id=v.business_id and i.store_id=v.store_id and i.variant_id=v.id
            where v.business_id=$1 and v.store_id=$2 and v.product_id=$3 and i.identifier_type='barcode' and i.identifier_value=$4 limit 1`,
          [businessId,job.store_id,product.id,normalized.variantBarcode]
        )).rows[0]??null;
        const addIssue=async(code,severity,details)=>{issues++;await client.query(
          `insert into mc.data_issues(business_id,store_id,document_id,report_row_id,code,severity,details)
           values($1,$2,$3,$4,$5,$6,$7::jsonb)`,
          [businessId,job.store_id,documentId,reportRow.id,code,severity,JSON.stringify(details)]
        );};
        if(normalized.wbArticle&&!product)await addIssue('financial_product_not_in_catalog','warning',{wbArticle:normalized.wbArticle});
        if(product&&normalized.variantBarcode&&!variant)await addIssue('financial_variant_not_matched','warning',{wbArticle:normalized.wbArticle});
        if(normalized.operationType==='unclassified')await addIssue('financial_operation_unclassified','blocking',{docTypeName:String(sourceRow.rawData.docTypeName??''),sellerOperName:String(sourceRow.rawData.sellerOperName??'')});
        const sourceOperationKey=`${source.externalReportId}/${sourceRow.externalRowKey}`;
        let operation=(await client.query(`select id from mc.operations where store_id=$1 and source_code='wb_finance' and source_operation_key=$2`,[job.store_id,sourceOperationKey])).rows[0];
        if(!operation)operation=(await client.query(
          `insert into mc.operations(business_id,store_id,source_code,source_operation_key) values($1,$2,'wb_finance',$3) returning id`,
          [businessId,job.store_id,sourceOperationKey]
        )).rows[0];
        const operationVersionNo=(await client.query(`select coalesce(max(version_no),0)+1 as n from mc.operation_versions where operation_id=$1`,[operation.id])).rows[0].n;
        const operationVersion=(await client.query(
          `insert into mc.operation_versions(business_id,store_id,operation_id,report_row_id,version_no,srid,operation_type,product_id,variant_id,accounting_date,source_occurred_at,quantity,currency,report_normalization_id)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'RUB',$13) returning id`,
          [businessId,job.store_id,operation.id,reportRow.id,operationVersionNo,normalized.srid,normalized.operationType,product?.id??null,variant?.id??null,normalized.accountingDate,normalized.sourceOccurredAt,normalized.quantity,normalization.id]
        )).rows[0];
        for(const component of normalized.components)await client.query(
          `insert into mc.financial_components(business_id,store_id,operation_version_id,component_key,category_code,amount_signed,method_version_id,source_field,result_scope_classification)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [businessId,job.store_id,operationVersion.id,component.componentKey,component.categoryCode,component.amountSigned,method.id,component.sourceField,product?'selected_product':'product_expected']
        );
        insertedRows++;
      }
      if(!reuseRows){
        await client.query(`update mc.report_versions set status='validated' where id=$1`,[version.id]);
        await client.query(`update mc.report_versions set status='accepted',accepted_at=now() where id=$1`,[version.id]);
        await client.query(`update mc.reports set current_version_id=$1 where id=$2`,[version.id,report.id]);
        insertedReports++;
      }else{
        normalizedReports++;
        if(report.current_version_id!==version.id){
          if(same.status!=='accepted')throw new Error('financial_report_version_not_accepted');
          await client.query(`update mc.reports set current_version_id=$1 where id=$2`,[version.id,report.id]);
          reselectedReports++;
        }
      }
      bankChecks[await recordBankCheck(client,businessId,job,source,version.id,summaries.get(source.externalReportId),summaryError)]++;
    }
    await client.query(
      `insert into mc.coverage_intervals(business_id,store_id,stream_id,source_document_id,date_from,date_to,status)
       values($1,$2,$3,$4,$5,$6,'complete')`,
      [businessId,job.store_id,job.stream_id,documentId,job.date_from,job.date_to]
    );
    if(insertedReports||normalizedReports||reselectedReports)await client.query(
      `insert into mc.calculation_invalidations(business_id,store_id,requested_by,reason,invalidated_at)
       values($1,$2,$3,'financial_normalization_changed',clock_timestamp())
       on conflict(store_id) do update set requested_by=excluded.requested_by,
         reason=excluded.reason,generation_token=gen_random_uuid(),invalidated_at=excluded.invalidated_at`,[businessId,job.store_id,userId]
    );
    const progress={stage:'complete',reports:reports.length,insertedReports,normalizedReports,reselectedReports,unchangedReports,rows:insertedRows,issues,bankChecks};
    await client.query(`update mc.sync_runs set status='succeeded',finished_at=now(),error_code=null,progress=$2::jsonb where id=$1 and status='running'`,[job.run_id,JSON.stringify(progress)]);
    const cursor=job.historical
      ?{historicalWeekStart:job.date_from}
      :{dateTo:job.date_to,reports:reports.length,rows:insertedRows};
    await client.query(
      `update mc.sync_streams set cursor=coalesce(cursor,'{}'::jsonb)||$2::jsonb,last_success_at=now(),next_run_at=now()+interval '24 hours' where id=$1`,
      [job.stream_id,JSON.stringify(cursor)]
    );
    return {documentId,insertedReports,normalizedReports,reselectedReports,unchangedReports,insertedRows,issues,bankChecks};
  });
}

export async function failFinancialSync(userId,job,errorCode,{retryDelaySeconds=70}={}){
  if(!Number.isInteger(retryDelaySeconds)||retryDelaySeconds<65||retryDelaySeconds>75)throw new Error('financial_invalid_rate_delay');
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    const code=String(errorCode).slice(0,100);
    const stream=(await client.query(
      `select id from mc.sync_streams where id=$1 and business_id=$2 and store_id=$3 for update`,
      [job.stream_id,businessId,job.store_id]
    )).rows[0];
    if(!stream)return;
    const failed=await client.query(`update mc.sync_runs set status='failed',finished_at=now(),error_code=$2,progress=jsonb_set(progress,'{stage}','"failed"') where id=$1 and business_id=$3 and status='running'`,[job.run_id,code,businessId]);
    if(!failed.rowCount)return;
    if(['financial_unauthorized','financial_payment_required','financial_token_type_unsupported'].includes(code)||(!job.historical&&code==='financial_invalid_request'))await client.query(`update mc.sync_streams set status='blocked',next_run_at=null where id=$1 and business_id=$2`,[job.stream_id,businessId]);
    else if(job.historical)await client.query(`update mc.sync_streams set next_run_at=greatest(coalesce(next_run_at,now()),now()+interval '24 hours') where id=$1 and business_id=$2`,[job.stream_id,businessId]);
    else if(code==='financial_rate_limited')await client.query(`update mc.sync_streams set next_run_at=now()+make_interval(secs=>$3) where id=$1 and business_id=$2`,[job.stream_id,businessId,retryDelaySeconds]);
    else await client.query(`update mc.sync_streams set next_run_at=now()+interval '15 minutes' where id=$1 and business_id=$2`,[job.stream_id,businessId]);
  });
}

export async function getFinancialSyncState(userId,storeId){
  return withOwnedBusinessContext(userId,async(client,businessId)=>(await client.query(
    `select ss.status as stream_status,ss.last_success_at,ss.next_run_at,
            r.status as run_status,r.error_code,r.started_at,r.finished_at,r.requested_from,r.requested_to,r.progress,
            (select max(ci.date_to) from mc.coverage_intervals ci where ci.business_id=ss.business_id and ci.store_id=ss.store_id and ci.stream_id=ss.id and ci.status='complete') as coverage_to,
            (select count(*)::int from mc.reports rp where rp.business_id=ss.business_id and rp.store_id=ss.store_id and rp.current_version_id is not null) as report_count,
            (select count(*)::int from mc.data_issues di where di.business_id=ss.business_id and di.store_id=ss.store_id and di.status='open') as issue_count,
            exists(select 1 from mc.product_selections ps where ps.business_id=ss.business_id and ps.store_id=ss.store_id and ps.status='confirmed') as selection_ready
       from mc.sync_streams ss
       left join lateral (select status,error_code,started_at,finished_at,requested_from,requested_to,progress from mc.sync_runs where stream_id=ss.id order by created_at desc limit 1) r on true
      where ss.business_id=$1 and ss.store_id=$2 and ss.source_type='financial_reports'`,[businessId,storeId]
  )).rows[0]??null);
}

export async function getFinancialBankReconciliationState(userId,storeId){
  return withOwnedBusinessContext(userId,async(client,businessId)=>(await client.query(
    `select count(*)::int as "reportCount",
            count(*) filter(where rc.status='passed')::int as passed,
            count(*) filter(where rc.status='failed')::int as failed,
            count(*) filter(where rc.status='not_checkable')::int as "notCheckable",
            count(*) filter(where rc.id is null)::int as unchecked,
            count(*) filter(where rc.details->>'reason' in ('summary_missing','financial_summary_unavailable','financial_summary_unauthorized','financial_summary_rate_limited','financial_invalid_summary','financial_duplicate_summary_conflict','financial_summary_too_large'))::int as "missingSummary"
       from mc.reports r
       left join lateral (
         select c.id,c.status,c.details from mc.reconciliation_checks c
          where c.business_id=r.business_id and c.store_id=r.store_id and c.report_version_id=r.current_version_id
            and c.check_code='wb_bank_payment_sum_v1'
          order by c.created_at desc,c.id desc limit 1
       ) rc on true
      where r.business_id=$1 and r.store_id=$2 and r.report_type='weekly_realization' and r.current_version_id is not null`,
    [businessId,storeId]
  )).rows[0]);
}
