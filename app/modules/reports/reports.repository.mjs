import { persistFinancialNormalization,reconcileHistoricalCatalogLinks } from './normalization.repository.mjs';
import { recoverHistoricalCatalog } from '../catalog/historical-catalog.repository.mjs';
import { createHash } from 'node:crypto';
import { withOwnedBusinessContext } from '../../infrastructure/database/client.mjs';
import { decimal, financialHistoricalWeekRange, financialParserVersion, financialReportPeriodMatches, stableJson } from './finance.mjs';
import { reconcileBankPayment } from './bank-reconciliation.mjs';
import { buildSellerOffsetReference } from './full-report-credit.mjs';

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

export async function refreshFinancialBankChecks(userId,storeId){
  return withOwnedBusinessContext(userId,async(client,businessId,role)=>{
    if(!['owner','editor'].includes(role))throw new Error('financial_bank_check_write_forbidden');
    // Serialize with report persistence; a retry keeps the old checks and appends only changed results.
    await client.query('select id from mc.businesses where id=$1 for update',[businessId]);
    const store=(await client.query(`select id from mc.stores where business_id=$1 and id=$2 and status='active'`,[businessId,storeId])).rows[0];
    if(!store)throw new Error('financial_store_unavailable');
    const candidates=(await client.query(
      `select r.external_report_id,r.period_start::text,r.period_end::text,rv.id as version_id,rv.checksum as report_checksum,
              summary.raw_data as summary_data,summary.source as summary_source,summary.id as summary_id,
              latest.id as prior_check_id,latest.status,latest.expected_amount,latest.actual_amount,latest.details
         from mc.reports r
         join mc.report_versions rv on rv.business_id=r.business_id and rv.store_id=r.store_id and rv.id=r.current_version_id and rv.status='accepted'
         join lateral (
           select candidate.id,candidate.status,candidate.expected_amount,candidate.actual_amount,candidate.details from mc.reconciliation_checks candidate
            where candidate.business_id=r.business_id and candidate.store_id=r.store_id and candidate.report_version_id=rv.id
              and candidate.check_code='wb_bank_payment_sum_v1'
            order by candidate.created_at desc,candidate.id desc limit 1
         ) latest on true
         join lateral (
           select saved.raw_data,saved.source,saved.id
             from (
               select candidate.raw_data,candidate.id,candidate.created_at as saved_at,'financial_report_summary_versions' as source
                 from mc.financial_report_summary_versions candidate
                where candidate.business_id=r.business_id and candidate.store_id=r.store_id and candidate.report_version_id=rv.id
               union all
               select candidate.summary_raw_data,candidate.id,candidate.last_seen_at,'financial_week_inventory'
                 from mc.financial_week_inventory candidate
                where candidate.business_id=r.business_id and candidate.store_id=r.store_id and candidate.report_version_id=rv.id
                  and candidate.fetch_status='accepted' and candidate.summary_raw_data is not null
                  and candidate.external_report_id=r.external_report_id
                  and candidate.period_start=r.period_start and candidate.period_end=r.period_end
             ) saved
            order by case when saved.source=case
              when latest.details->>'source'='durable_pipeline' or latest.details->>'summarySource'='financial_week_inventory'
                then 'financial_week_inventory' else 'financial_report_summary_versions' end
              then 0 else 1 end,saved.saved_at desc,saved.id desc limit 1
         ) summary on true
        where r.business_id=$1 and r.store_id=$2 and r.report_type='weekly_realization'
          and ((latest.status='failed' and latest.details->>'reason'='bank_payment_mismatch')
            or (latest.status='not_checkable' and latest.details->>'reason'='summary_detail_mismatch'))
        order by r.period_start,r.id`,[businessId,storeId]
    )).rows;
    let updated=0;
    for(const candidate of candidates){
      const rows=(await client.query(
        `select raw_data from mc.report_rows where business_id=$1 and store_id=$2 and report_version_id=$3 order by row_number,id`,
        [businessId,storeId,candidate.version_id]
      )).rows.map(row=>({rawData:row.raw_data}));
      const result=reconcileBankPayment({
        externalReportId:candidate.external_report_id,periodStart:candidate.period_start,periodEnd:candidate.period_end,rows
      },candidate.summary_data);
      if(result.status===candidate.status&&result.reason===(candidate.details?.reason??null)
        &&decimal(result.expectedAmount)===decimal(candidate.expected_amount)
        &&decimal(result.actualAmount)===decimal(candidate.actual_amount))continue;
      await client.query(
        `insert into mc.reconciliation_checks(business_id,store_id,report_version_id,check_code,expected_amount,actual_amount,status,details,created_at)
         values($1,$2,$3,'wb_bank_payment_sum_v1',$4,$5,$6,$7::jsonb,clock_timestamp())`,
        [businessId,storeId,candidate.version_id,result.expectedAmount,result.actualAmount,result.status,JSON.stringify({
          reason:result.reason,summaryChecksum:createHash('sha256').update(stableJson(candidate.summary_data)).digest('hex'),
          summarySource:candidate.summary_source,summaryId:candidate.summary_id,reportChecksum:candidate.report_checksum,
          toleranceVersion:'financial-half-kopeck-v1',priorCheckId:candidate.prior_check_id
        })]
      );
      updated++;
    }
    return{checked:candidates.length,updated};
  });
}

const exactDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value??''))?String(value):null;

export function selectHistoricalRenormalizationWeek(candidates,{initialRange,recentRange}={}){
  const initialFrom=exactDate(initialRange?.dateFrom),initialTo=exactDate(initialRange?.dateTo);
  const recentFrom=exactDate(recentRange?.dateFrom);
  if(!initialFrom||!initialTo||!recentFrom)return null;
  return candidates.map(candidate=>({dateFrom:exactDate(candidate?.date_from??candidate?.dateFrom),dateTo:exactDate(candidate?.date_to??candidate?.dateTo)}))
    .filter(candidate=>{
      if(!candidate.dateFrom||!candidate.dateTo||candidate.dateFrom<initialFrom||candidate.dateTo>initialTo||candidate.dateFrom>=recentFrom)return false;
      const start=new Date(`${candidate.dateFrom}T00:00:00Z`),end=new Date(`${candidate.dateTo}T00:00:00Z`);
      return start.getUTCDay()===1&&end.getUTCDay()===0&&end.getTime()-start.getTime()===6*86400000;
    })
    .sort((a,b)=>b.dateFrom.localeCompare(a.dateFrom)||b.dateTo.localeCompare(a.dateTo))[0]??null;
}

export async function beginFinancialSync(userId,storeId,{force=false,historical=false,initialRange,recentRange,requestedRange=null,targetPeriod=null}={}){
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    const requestedFrom=exactDate(requestedRange?.periodStart??requestedRange?.dateFrom);
    const requestedTo=exactDate(requestedRange?.periodEnd??requestedRange?.dateTo);
    const targetFrom=exactDate(targetPeriod?.periodStart??targetPeriod?.dateFrom);
    const targetTo=exactDate(targetPeriod?.periodEnd??targetPeriod?.dateTo);
    const targeted=Boolean(requestedRange||targetPeriod);
    if(targeted&&(!requestedFrom||!requestedTo||!targetFrom||!targetTo||requestedFrom>requestedTo||targetFrom>targetTo))throw new Error('financial_invalid_request');
    const row=(await client.query(
      `select ss.id as stream_id,ss.next_run_at,ss.last_success_at,ss.cursor,cs.ciphertext,cs.nonce,cs.auth_tag,s.external_account_id as seller_id
         from mc.stores s
         join mc.connections c on c.business_id=s.business_id and c.store_id=s.id and c.status='active'
         join mc.connection_secrets cs on cs.business_id=c.business_id and cs.connection_id=c.id
         join mc.sync_streams ss on ss.business_id=s.business_id and ss.store_id=s.id and ss.source_type='financial_reports' and ss.status='active'
        where s.business_id=$1 and s.id=$2 and s.status='active'
        for update of ss`,[businessId,storeId]
    )).rows[0];
    if(!row)throw new Error('financial_connection_unavailable');
    if(!force&&row.next_run_at&&new Date(row.next_run_at)>new Date())return {started:false,reason:'not_due'};
    const running=(await client.query(`select id,started_at from mc.sync_runs where stream_id=$1 and status='running'`,[row.stream_id])).rows[0];
    if(running&&new Date(running.started_at)>new Date(Date.now()-3*60*60*1000))return {started:false,reason:'running'};
    if(running)await client.query(`update mc.sync_runs set status='failed',finished_at=now(),error_code='financial_interrupted' where id=$1`,[running.id]);
    let range=row.last_success_at?recentRange:initialRange;
    if(targeted){
      const eligible=(await client.query(
        `select 1
           from mc.reports r
           join mc.report_versions rv on rv.id=r.current_version_id and rv.status='accepted'
          where r.business_id=$1 and r.store_id=$2 and r.report_type='weekly_realization'
            and r.period_start=$3::date and r.period_end=$4::date
            and r.period_start<=$6::date and r.period_end>=$5::date
            and not exists(
              select 1 from mc.report_normalizations rn
              join mc.method_versions m on m.id=rn.method_version_id
               where rn.report_version_id=rv.id and rn.status='succeeded'
                 and m.code='wb_finance_import' and m.implementation_version=$7
            )
          limit 1`,
        [businessId,storeId,requestedFrom,requestedTo,targetFrom,targetTo,financialParserVersion]
      )).rows[0];
      if(!eligible)return {started:false,reason:'target_range_not_needed'};
      historical=true;
      range={dateFrom:requestedFrom,dateTo:requestedTo};
    }else if(historical){
      const missingCurrentNormalization=(await client.query(
        `select distinct r.period_start::text as date_from,r.period_end::text as date_to
           from mc.reports r
           join mc.report_versions rv on rv.id=r.current_version_id and rv.status='accepted'
          where r.business_id=$1 and r.store_id=$2 and not exists(
            select 1 from mc.report_normalizations rn join mc.method_versions m on m.id=rn.method_version_id
             where rn.report_version_id=rv.id and rn.status='succeeded'
               and m.code='wb_finance_import' and m.implementation_version=$3
          ) and r.report_type='weekly_realization'`,[businessId,storeId,financialParserVersion]
      )).rows;
      range=selectHistoricalRenormalizationWeek(missingCurrentNormalization,{initialRange,recentRange});
      if(!range){
        const earliest=(await client.query(
          `select min(date_from)::text as earliest from mc.coverage_intervals
            where business_id=$1 and store_id=$2 and stream_id=$3 and status='complete'`,
          [businessId,storeId,row.stream_id]
        )).rows[0]?.earliest;
        range=financialHistoricalWeekRange(earliest,recentRange?.dateFrom,row.cursor?.historicalWeekStart);
      }
      if(!range)return {started:false,reason:'no_historical_week'};
    }
    if(!range?.dateFrom||!range?.dateTo)throw new Error('financial_invalid_request');
    const run=(await client.query(
      `insert into mc.sync_runs(business_id,store_id,stream_id,requested_from,requested_to,status,started_at,progress)
       values($1,$2,$3,$4,$5,'running',now(),$6::jsonb) returning id`,
      [businessId,storeId,row.stream_id,range.dateFrom,range.dateTo,JSON.stringify({stage:'loading',pages:0,rows:0,...(targeted?{targeted:true,targetPeriod:{periodStart:targetFrom,periodEnd:targetTo}}:{})})]
    )).rows[0];
    if(!historical)await client.query(`update mc.sync_streams set next_run_at=null where id=$1`,[row.stream_id]);
    return {started:true,historical,targeted,target_period:targeted?{periodStart:targetFrom,periodEnd:targetTo}:null,business_id:businessId,store_id:storeId,stream_id:row.stream_id,run_id:run.id,date_from:range.dateFrom,date_to:range.dateTo,seller_id:row.seller_id,ciphertext:row.ciphertext,nonce:row.nonce,auth_tag:row.auth_tag};
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
    await client.query(`update mc.sync_runs set progress=coalesce(progress,'{}'::jsonb)||$2::jsonb where id=$1 and business_id=$3 and status='running'`,[job.run_id,JSON.stringify(progress),businessId]);
  });
}

async function resolveLegacyDataIssues(client,businessId,storeId,reportId,resolverNormalizationId,preferPrevious=false){
  await client.query(
    `with candidates as (
       select di.id,di.report_row_id,di.code,selected.id as normalization_id,
              exists(
                select 1 from mc.data_issues linked
                 where linked.report_normalization_id=selected.id and linked.report_row_id=di.report_row_id
                   and linked.code=di.code and linked.status='open'
              ) as linked_exists,
              row_number() over(partition by selected.id,di.report_row_id,di.code order by di.created_at,di.id) as position
         from mc.data_issues di
         join mc.report_rows rr on rr.id=di.report_row_id
         join mc.report_versions old_version on old_version.id=rr.report_version_id
         cross join lateral (
           select rn.id
             from mc.report_normalizations rn
             join mc.method_versions m on m.id=rn.method_version_id
            where rn.business_id=$1 and rn.store_id=$2 and rn.report_version_id=rr.report_version_id and rn.status='succeeded'
            order by (case when $5 then (rn.id=$4)::int else 0 end),m.version_no desc,rn.catalog_revision desc,rn.normalized_at desc,rn.id desc
            limit 1
         ) selected
        where di.business_id=$1 and di.store_id=$2 and old_version.report_id=$3
          and di.status='open' and di.report_normalization_id is null
     ), resolved_conflicts as (
       update mc.data_issues di
          set report_normalization_id=c.normalization_id,status='resolved',resolved_at=now(),resolved_by_normalization_id=c.normalization_id
         from candidates c
        where di.id=c.id and (c.linked_exists or c.position>1)
       returning di.id
     )
     update mc.data_issues di
        set report_normalization_id=c.normalization_id
       from candidates c
      where di.id=c.id and not c.linked_exists and c.position=1
        and (select count(*) from resolved_conflicts)>=0`,
    [businessId,storeId,reportId,resolverNormalizationId,preferPrevious]
  );
  await client.query(
    `update mc.data_issues di
        set status='resolved',resolved_at=now(),resolved_by_normalization_id=$1
       from mc.report_rows rr
       join mc.report_versions old_version on old_version.id=rr.report_version_id
      where di.business_id=$2 and di.store_id=$3 and di.report_row_id=rr.id
        and old_version.report_id=$4 and di.status='open'
        and di.report_normalization_id is distinct from $1`,
    [resolverNormalizationId,businessId,storeId,reportId]
  );
}

export async function completeFinancialSync(userId,job,{documentId,reports,summaries=new Map(),summaryError=null,objects=[]}){
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    if(businessId!==job.business_id)throw new Error('financial_context_mismatch');
    await client.query('select id from mc.businesses where id=$1 for update',[businessId]);
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
      const same=(await client.query(`select id,status from mc.report_versions where report_id=$1 and checksum=$2 and parser_version=$3`,[report.id,source.checksum,financialParserVersion])).rows[0];
      let version,reuseRows=false;
      if(same){
        const recovery=await recoverHistoricalCatalog(client,{businessId,storeId:job.store_id,reportVersionId:same.id});
        const existingNormalization=(await client.query(`select id from mc.report_normalizations where report_version_id=$1 and method_version_id=$2 and catalog_revision=$3`,[same.id,method.id,recovery.catalogRevision])).rows[0];
        if(existingNormalization){
          if(report.current_version_id===same.id)unchangedReports++;
          else{
            if(same.status!=='accepted')throw new Error('financial_report_version_not_accepted');
            await client.query(`update mc.reports set current_version_id=$1 where id=$2`,[same.id,report.id]);
            reselectedReports++;
          }
          await resolveLegacyDataIssues(client,businessId,job.store_id,report.id,existingNormalization.id);
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
      if(!reuseRows){
        let rowNumber=0;
        for(const row of source.rows)await client.query(
          `insert into mc.report_rows(business_id,store_id,report_version_id,external_row_key,row_number,raw_data,row_checksum) values($1,$2,$3,$4,$5,$6::jsonb,$7)`,
          [businessId,job.store_id,version.id,row.externalRowKey,++rowNumber,JSON.stringify(row.rawData),row.rowChecksum]);
        await client.query(`update mc.report_versions set status='validated' where id=$1`,[version.id]);
      }
      const recovery=await recoverHistoricalCatalog(client,{businessId,storeId:job.store_id,reportVersionId:version.id});
      const normalization=await persistFinancialNormalization(client,{businessId,storeId:job.store_id,reportVersionId:version.id,catalogRevision:recovery.catalogRevision});
      insertedRows+=normalization.insertedRows;issues+=normalization.issues;
      await resolveLegacyDataIssues(client,businessId,job.store_id,report.id,normalization.id,true);
      if(!reuseRows){
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
    await reconcileHistoricalCatalogLinks(client,{businessId,storeId:job.store_id});
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
    const progress={stage:'complete',reports:reports.length,insertedReports,normalizedReports,reselectedReports,unchangedReports,rows:insertedRows,issues,bankChecks,...(job.targeted?{targeted:true,targetPeriod:job.target_period}:{})};
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
    `select case when connection.status='active' and connection.scopes ? 'finance' then 'active' else 'blocked' end as stream_status,
            pipeline.last_success_at,
            (select min(coverage.next_retry_at) from mc.financial_week_coverage coverage
              where coverage.business_id=store.business_id and coverage.store_id=store.id
                and coverage.credential_generation=connection.credential_generation
                and coverage.coverage_status='retry') as next_run_at,
            case when active_job.id is not null then 'running'
                 when coverage_state.terminal then 'failed'
                 when coverage_state.waiting then 'failed'
                 when failed_job.id is not null and (pipeline.last_success_at is null or failed_job.finished_at>pipeline.last_success_at) then 'failed'
                 when pipeline.last_success_at is not null then 'succeeded' end as run_status,
            case when active_job.id is null
                   and (coverage_state.terminal
                     or coverage_state.waiting
                     or (pipeline.last_success_at is null or failed_job.finished_at>pipeline.last_success_at))
                 then coalesce(coverage_state.terminal_error,coverage_state.waiting_error,failed_job.last_error_code) end as error_code,
            coalesce(active_job.created_at,failed_job.created_at) as started_at,
            active_job.job_type as active_job_type,
            active_job.status as active_job_status,
            active_job.available_at as active_job_available_at,
            case when active_job.id is null then failed_job.finished_at end as finished_at,
            coalesce(active_job.payload,failed_job.payload)->'window'->>'dateFrom' as requested_from,
            coalesce(active_job.payload,failed_job.payload)->'window'->>'dateTo' as requested_to,
            jsonb_build_object('stage',case coalesce(active_job.job_type,failed_job.job_type)
              when 'financial_inventory_refresh' then 'inventory'
              when 'financial_report_fetch' then 'loading'
              when 'financial_report_normalize' then 'saving'
              else 'idle' end) as progress,
            coverage_state.total_weeks,
            coverage_state.complete_weeks,
            coverage_state.empty_weeks,
            coverage_state.pending_weeks,
            coverage_state.failed_weeks,
            (select max(coverage.week_end) from mc.financial_week_coverage coverage
              where coverage.business_id=store.business_id and coverage.store_id=store.id
                and coverage.credential_generation=connection.credential_generation
                and coverage.coverage_status in ('complete','empty')) as coverage_to,
            (select count(*)::int from mc.reports rp where rp.business_id=store.business_id and rp.store_id=store.id and rp.current_version_id is not null) as report_count,
            (select count(*)::int
               from mc.data_issues di
               join mc.report_normalizations rn on rn.id=di.report_normalization_id
               join mc.report_versions rv on rv.id=rn.report_version_id
               join mc.reports rp on rp.id=rv.report_id and rp.current_version_id=rv.id
              where di.business_id=store.business_id and di.store_id=store.id and di.status='open'
                and rn.status='succeeded'
                and not exists(
                  select 1 from mc.report_normalizations newer
                  join mc.method_versions newer_method on newer_method.id=newer.method_version_id
                  join mc.method_versions current_method on current_method.id=rn.method_version_id
                  where newer.report_version_id=rn.report_version_id and newer.status='succeeded'
                    and newer_method.code=current_method.code and (newer_method.version_no>current_method.version_no or (newer_method.version_no=current_method.version_no and newer.catalog_revision>rn.catalog_revision))
                )) as issue_count,
            exists(select 1 from mc.active_profile_products ps where ps.business_id=store.business_id and ps.store_id=store.id) as selection_ready
       from mc.stores store
       join mc.connections connection on connection.business_id=store.business_id and connection.store_id=store.id
       left join lateral (
         select max(job.finished_at) filter(where job.status='succeeded') as last_success_at
           from mc.jobs job where job.business_id=store.business_id and job.store_id=store.id
             and job.job_type in ('financial_inventory_refresh','financial_report_fetch','financial_report_normalize')
             and (job.payload->>'credentialGeneration')::bigint=connection.credential_generation
       ) pipeline on true
       left join lateral (
         select job.id,job.job_type,job.status,job.available_at,job.created_at,job.payload
           from mc.jobs job where job.business_id=store.business_id and job.store_id=store.id
             and job.job_type in ('financial_inventory_refresh','financial_report_fetch','financial_report_normalize')
             and job.status in ('pending','running')
             and (job.payload->>'credentialGeneration')::bigint=connection.credential_generation
          order by case job.job_type when 'financial_report_normalize' then 0 when 'financial_report_fetch' then 1 else 2 end,
                   job.created_at,job.id limit 1
       ) active_job on true
       left join lateral (
         select job.id,job.job_type,job.last_error_code,job.created_at,job.finished_at,job.payload
           from mc.jobs job where job.business_id=store.business_id and job.store_id=store.id
             and job.job_type in ('financial_inventory_refresh','financial_report_fetch','financial_report_normalize')
             and job.status='failed'
             and (job.payload->>'credentialGeneration')::bigint=connection.credential_generation
          order by job.finished_at desc nulls last,job.id desc limit 1
       ) failed_job on true
       left join lateral (
         select coalesce(bool_or(coverage.coverage_status in ('pending','inventory_confirmed','fetching','retry')),false) as waiting,
                coalesce(bool_or(coverage.coverage_status in ('partial','unavailable')),false) as terminal,
             count(*)::int as total_weeks,
             count(*) filter(where coverage.coverage_status='complete')::int as complete_weeks,
             count(*) filter(where coverage.coverage_status='empty')::int as empty_weeks,
             count(*) filter(where coverage.coverage_status in ('pending','inventory_confirmed','fetching','retry'))::int as pending_weeks,
                count(*) filter(where coverage.coverage_status in ('partial','unavailable'))::int as failed_weeks,
                (array_agg(coverage.last_error_code order by coverage.updated_at desc)
                  filter(where coverage.coverage_status in ('partial','unavailable') and coverage.last_error_code is not null))[1] as terminal_error,
                (array_agg(coverage.last_error_code order by coverage.updated_at desc)
                  filter(where coverage.coverage_status in ('pending','inventory_confirmed','fetching','retry') and coverage.last_error_code is not null))[1] as waiting_error
           from mc.financial_week_coverage coverage
          where coverage.business_id=store.business_id and coverage.store_id=store.id
            and coverage.credential_generation=connection.credential_generation
       ) coverage_state on true
      where store.business_id=$1 and store.id=$2`,[businessId,storeId]
  )).rows[0]??null);
}

export async function requestFinancialInventoryRefresh(userId,storeId,{now=new Date()}={}){
  return withOwnedBusinessContext(userId,async client=>(await client.query(
    'select * from mc.request_financial_inventory_refresh($1,$2)',[storeId,now]
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

export async function getFinancialSellerOffsetReference(userId,storeId,reportId){
  const externalReportId=String(reportId??'');
  if(!/^\d+$/.test(externalReportId))throw new Error('seller_offset_report_invalid');
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    const report=(await client.query(
      `select id,external_report_id,period_start::text as period_start,period_end::text as period_end,current_version_id
         from mc.reports
        where business_id=$1 and store_id=$2 and report_type='weekly_realization' and external_report_id=$3`,
      [businessId,storeId,externalReportId]
    )).rows[0];
    if(!report?.current_version_id)return null;
    const rows=(await client.query(
      `select raw_data from mc.report_rows
        where business_id=$1 and store_id=$2 and report_version_id=$3
        order by row_number,id`,
      [businessId,storeId,report.current_version_id]
    )).rows.map(row=>row.raw_data);
    return{
      reportUuid:report.id,
      periodStart:report.period_start,
      periodEnd:report.period_end,
      ...buildSellerOffsetReference({reportId:report.external_report_id,rows})
    };
  });
}
