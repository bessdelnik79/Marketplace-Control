import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const url=process.env.OPERATIONAL_CACHE_INTEGRATION_DATABASE_URL;
const readRole=process.env.OPERATIONAL_CACHE_READ_ROLE;
if(readRole&&!/^[a-z_][a-z0-9_]*$/.test(readRole))throw new Error('OPERATIONAL_CACHE_READ_ROLE must be a trusted disposable test role name.');
if(!url||!new URL(url).pathname.toLowerCase().includes('test'))throw new Error('Set OPERATIONAL_CACHE_INTEGRATION_DATABASE_URL to a disposable test PostgreSQL database.');
process.env.DATABASE_URL=url;
const {migrate,pool}=await import('../../app/infrastructure/database/client.mjs');
const {beginOperationalSync,completeOperationalSync,failOperationalSync,getOperationalCachedSources,getOperationalOverviewData,requestOperationalRangeRefresh}=await import('../../app/modules/operational/operational.repository.mjs');
const {persistFinancialNormalization}=await import('../../app/modules/reports/normalization.repository.mjs');
const {readFinancialReturnsCache}=await import('../../app/modules/operational/financial-returns-cache.mjs');
const {storeOperationalSnapshot}=await import('../../app/infrastructure/storage/operational-source-storage.mjs');
const ids={user:randomUUID(),business:randomUUID(),store:randomUUID(),product:randomUUID(),foreignUser:randomUUID(),foreignBusiness:randomUUID()};
const range={dateFrom:'2026-09-14',dateTo:'2026-09-20'},now=new Date('2026-09-21T12:00:00Z');
const root=await mkdtemp(path.join(os.tmpdir(),'mc-op-finance-cache-')),storage={root,masterKey:Buffer.alloc(32,17)};
await migrate();
async function context(action,{user=ids.user,business=ids.business}={}){
  const client=await pool.connect();
  try{await client.query('begin');await client.query(`select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)`,[user,business]);
    const result=await action(client);await client.query('commit');return result;
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}
await context(async client=>{
  await client.query(`insert into mc.users(id,display_name) values($1,'Cache owner')`,[ids.user]);
  await client.query(`insert into mc.businesses(id,name) values($1,'Cache business')`,[ids.business]);
  await client.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[ids.business,ids.user]);
  await client.query(`insert into mc.stores(id,business_id,external_account_id,name,status) values($1,$2,'cache-seller','Cache store','active')`,[ids.store,ids.business]);
  const connection=(await client.query(`insert into mc.connections(business_id,store_id,secret_ref,scopes,status,credential_generation) values($1,$2,'test','["finance","analytics","statistics"]','active',1) returning id`,[ids.business,ids.store])).rows[0];
  await client.query(`insert into mc.connection_secrets(business_id,connection_id,ciphertext,nonce,auth_tag) values($1,$2,decode('abcd','hex'),decode(repeat('01',12),'hex'),decode(repeat('02',16),'hex'))`,[ids.business,connection.id]);
  const catalog=(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','catalog','cache-catalog','complete') returning id`,[ids.business,ids.store])).rows[0];
  await client.query(`insert into mc.products(id,business_id,store_id,wb_article,seller_article) values($1,$2,$3,7200001,'CACHE')`,[ids.product,ids.business,ids.store]);
  await client.query(`select mc.confirm_product_selection($1,$2,$3::uuid[])`,[ids.store,catalog.id,[ids.product]]);
});
await context(async client=>{
  await client.query(`insert into mc.users(id,display_name) values($1,'Foreign owner')`,[ids.foreignUser]);
  await client.query(`insert into mc.businesses(id,name) values($1,'Foreign business')`,[ids.foreignBusiness]);
  await client.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[ids.foreignBusiness,ids.foreignUser]);
},{user:ids.foreignUser,business:ids.foreignBusiness});

let coverageId,inventoryId,reportId,firstVersion,firstNormalization;
async function addVersion(client,versionNo,{returnQuantity=2,unitPrice='100.1250',operation='Возврат'}={}){
  const document=(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','weekly_realization',$3,'complete') returning id`,[ids.business,ids.store,`document-${versionNo}`])).rows[0];
  const version=(await client.query(`insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version) values($1,$2,$3,$4,$5,$6,'wb-finance-v13') returning id`,[ids.business,ids.store,reportId,document.id,versionNo,`version-${versionNo}`])).rows[0];
  const raw={docTypeName:'Возврат',sellerOperName:operation,nmId:'7200001',rrdId:`${versionNo}`,rrDate:'2026-09-15',saleDate:'2026-09-10',quantity:String(returnQuantity),retailPriceWithdiscRub:unitPrice,retailAmount:'1',forPay:'1'};
  await client.query(`insert into mc.report_rows(business_id,store_id,report_version_id,external_row_key,row_number,raw_data,row_checksum) values($1,$2,$3,'1',1,$4::jsonb,$5)`,[ids.business,ids.store,version.id,JSON.stringify(raw),`row-${versionNo}`]);
  await client.query(`update mc.report_versions set status='validated' where id=$1`,[version.id]);
  await client.query(`update mc.report_versions set status='accepted',accepted_at=clock_timestamp() where id=$1`,[version.id]);
  await client.query(`update mc.reports set current_version_id=$1 where id=$2`,[version.id,reportId]);
  const catalogRevision=(await client.query(`select catalog_revision from mc.stores where id=$1`,[ids.store])).rows[0].catalog_revision;
  const normalization=await persistFinancialNormalization(client,{businessId:ids.business,storeId:ids.store,reportVersionId:version.id,catalogRevision});
  return {versionId:version.id,normalizationId:normalization.id};
}
await context(async client=>{
  reportId=(await client.query(`insert into mc.reports(business_id,store_id,external_report_id,period_start,period_end) values($1,$2,'12345',$3,$4) returning id`,[ids.business,ids.store,range.dateFrom,range.dateTo])).rows[0].id;
  const first=await addVersion(client,1);firstVersion=first.versionId;firstNormalization=first.normalizationId;
  coverageId=(await client.query(`insert into mc.financial_week_coverage(business_id,store_id,credential_generation,week_start,week_end,check_reasons,coverage_status,inventory_confirmed_at) values($1,$2,1,$3,$4,ARRAY['test'],'complete',clock_timestamp()) returning id`,[ids.business,ids.store,range.dateFrom,range.dateTo])).rows[0].id;
  inventoryId=(await client.query(`insert into mc.financial_week_inventory(business_id,store_id,coverage_id,external_report_id,inventory_checksum,period_start,period_end,fetch_status,report_version_id,accepted_normalization_id,accepted_inventory_checksum,accepted_at) values($1,$2,$3,'12345',$4,$5,$6,'accepted',$7,$8,$4,clock_timestamp()) returning id`,[ids.business,ids.store,coverageId,'a'.repeat(64),range.dateFrom,range.dateTo,firstVersion,firstNormalization])).rows[0].id;
});

async function job(){const result=await beginOperationalSync(ids.user,ids.store,{force:true,...range});assert.equal(result.started,true,result.reason);return result;}
async function cache(job){return getOperationalCachedSources(ids.user,job,{now});}
async function publish(job,returnsRows=null,{fetchedAt=now,unknownReturns=false}={}){
  const snapshotId=randomUUID(),object=await storeOperationalSnapshot({businessId:ids.business,storeId:ids.store,snapshotId,raw:JSON.stringify({cache:returnsRows}),...storage});
  const metrics=Array.from({length:7},(_,index)=>{const date=new Date(Date.parse(job.date_from)+index*86400000).toISOString().slice(0,10);
    return {nmId:7200001,date,currency:'RUB',orderCount:3,orderSum:'300',buyoutCount:1,buyoutSum:'100',cancelCount:88,cancelSum:'888',returnCount:unknownReturns?null:8,returnSum:unknownReturns?null:'800',
      ...(returnsRows?.find(row=>row.date===date)??{})};});
  return completeOperationalSync(ids.user,job,{documentId:randomUUID(),snapshotId,objects:[object],metrics,fetchedAt,storage});
}

test('cache integration runs under real forced RLS, not superuser bypass',async()=>{
  const role=(await pool.query(`select rolsuper,rolbypassrls from pg_roles where rolname=current_user`)).rows[0];
  assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
  const rows=await context(client=>client.query(`select id from mc.financial_week_coverage where id=$1`,[coverageId]),{user:ids.foreignUser,business:ids.foreignBusiness});
  assert.equal(rows.rowCount,0);
  await assert.rejects(()=>getOperationalCachedSources(ids.foreignUser,{business_id:ids.business,store_id:ids.store,credential_generation:1,products:[]},{now}),/business|forbidden|membership|context/);
});

test('confirmed complete financial week supplies purchase returns and proven daily zeros without operational fetch',async()=>{
  const pending=await job(),saved=await cache(pending);
  assert.equal(saved.funnelRows.length,0);assert.equal(saved.returnsRows.length,7);
  const actual=saved.returnsRows.find(row=>row.date==='2026-09-15');
  assert.deepEqual([actual.returnCount,actual.returnSum,actual.returnDateBasis],[2,'200.2500','accounting_date']);
  assert.ok(saved.returnsRows.filter(row=>row!==actual).every(row=>row.returnCount===0&&row.returnSum==='0.0000'));
  assert.equal(actual.returnSourceRefs.inventory[0].reportNormalizationId,firstNormalization);
  assert.equal(actual.returnSourceRefs.rows[0].reportVersionId,firstVersion);
  assert.equal(JSON.parse(saved.raw).source,'accepted_database_cache');
  await failOperationalSync(ids.user,pending,'test_cleanup');
});

test('closed operational days have no daily refetch TTL and finance wins over cached Statistics returns',async()=>{
  await publish(await job());
  const promotion=await requestOperationalRangeRefresh(ids.user,ids.store,range.dateFrom,range.dateTo,{now});
  assert.equal(promotion.queued,35); // Seven known Statistics days need a local financial upgrade.
  const pending=await job(),saved=await cache(pending);
  assert.equal(saved.funnelRows.length,7);assert.equal(saved.funnelRows[0].orderCount,3);
  assert.equal(saved.returnsRows.find(row=>row.date==='2026-09-15').returnCount,2);
  await publish(pending,saved.returnsRows);
  const queued=await requestOperationalRangeRefresh(ids.user,ids.store,range.dateFrom,range.dateTo,{now:new Date('2026-10-04T12:00:00Z')});
  assert.equal(queued.queued,0);assert.equal(queued.pendingDays,28); // Only already queued comparison weeks remain.
});

test('scoped operational reader preserves every current column and verifies each full financial refs set once',async()=>{
  await context(async client=>{
    const params=[ids.business,ids.store,range.dateFrom,range.dateTo,[ids.product]];
    const before=(await client.query(`select * from mc.current_operational_daily_metrics
      where business_id=$1 and store_id=$2 and metric_date between $3 and $4 and product_id=any($5::uuid[])
      order by metric_date,product_id`,params)).rows;
    const after=(await client.query(`select * from mc.current_operational_daily_metrics_for_range($1,$2,$3::date,$4::date,$5::uuid[])
      order by metric_date,product_id`,params)).rows;
    assert.equal(after.length,7);assert.deepEqual(after,before);
    const uniqueRefs=new Set(after.filter(row=>row.return_source==='financial_report').map(row=>JSON.stringify(row.return_source_refs)));
    assert.ok(uniqueRefs.size>0&&uniqueRefs.size<after.length);
    const functionBody=(await client.query(`select prosrc from pg_proc where oid=
      'mc.current_operational_daily_metrics_for_range(uuid,uuid,date,date,uuid[])'::regprocedure`)).rows[0].prosrc;
    let sql=functionBody;
    for(const[name,parameter]of [['target_business','$1'],['target_store','$2'],['target_start','$3::date'],['target_end','$4::date'],['target_products','$5::uuid[]']]){
      sql=sql.replace(new RegExp('\\b'+name+'\\b','g'),()=>parameter);
    }
    const plan=(await client.query('explain (analyze,buffers,format json) '+sql,params)).rows[0]['QUERY PLAN'][0].Plan;
    const checks=[];function walk(node){if(node['Subplan Name']==='CTE checked_refs')checks.push(node);for(const child of node.Plans??[])walk(child);}walk(plan);
    assert.equal(checks.length,1);assert.equal(checks[0]['Actual Rows'],uniqueRefs.size);assert.equal(checks[0]['Actual Loops'],1);
    const narrowed=(await client.query(`select * from mc.current_operational_daily_metrics_for_range($1,$2,$3::date,$3::date,$4::uuid[])`,
      [ids.business,ids.store,range.dateFrom,[ids.product]])).rows;
    assert.equal(narrowed.length,1);assert.equal(narrowed[0].metric_date.toISOString().slice(0,10),range.dateFrom);
    assert.equal((await client.query(`select * from mc.current_operational_daily_metrics_for_range($1,$2,$3::date,$4::date,$5::uuid[])`,
      [ids.business,ids.store,range.dateFrom,range.dateTo,[randomUUID()]])).rowCount,0);
  });
});

test('scoped operational reader cannot expose a foreign tenant or another store',async()=>{
  const foreignRows=await context(client=>client.query(`select * from mc.current_operational_daily_metrics_for_range($1,$2,$3::date,$4::date,$5::uuid[])`,
    [ids.business,ids.store,range.dateFrom,range.dateTo,[ids.product]]),{user:ids.foreignUser,business:ids.foreignBusiness});
  assert.equal(foreignRows.rowCount,0);
  const rows=await context(client=>client.query(`select * from mc.current_operational_daily_metrics_for_range($1,$2,$3::date,$4::date,$5::uuid[])`,
    [ids.business,randomUUID(),range.dateFrom,range.dateTo,[ids.product]]));
  assert.equal(rows.rowCount,0);
});

test('non-owner SELECT-only role reads the scoped function under forced RLS',{skip:!readRole},async()=>{
  await context(async client=>{
    await client.query(`grant usage on schema mc to ${readRole}`);
    await client.query(`grant select on mc.operational_snapshot_activations,mc.operational_snapshots,mc.operational_periods,
      mc.operational_snapshot_products,mc.operational_daily_metrics,mc.current_operational_daily_metrics,
      mc.financial_week_coverage,mc.connections,mc.stores,mc.jobs,mc.financial_week_inventory,
      mc.report_versions,mc.reports,mc.report_normalizations,mc.method_versions,mc.data_issues to ${readRole}`);
    await client.query(`grant execute on function mc.context_business_id(),mc.context_user_id(),
      mc.operational_financial_return_refs_current(uuid,uuid,jsonb),
      mc.current_operational_daily_metrics_for_range(uuid,uuid,date,date,uuid[]) to ${readRole}`);
    await client.query(`set local role ${readRole}`);
    const role=(await client.query(`select current_user name,rolsuper,rolbypassrls from pg_roles where rolname=current_user`)).rows[0];
    assert.equal(role.name,readRole);assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
    const params=[ids.business,ids.store,range.dateFrom,range.dateTo,[ids.product]];
    const original=(await client.query(`select * from mc.current_operational_daily_metrics where business_id=$1 and store_id=$2
      and metric_date between $3 and $4 and product_id=any($5::uuid[]) order by metric_date,product_id`,params)).rows;
    const scoped=(await client.query(`select * from mc.current_operational_daily_metrics_for_range($1,$2,$3::date,$4::date,$5::uuid[])
      order by metric_date,product_id`,params)).rows;
    assert.equal(scoped.length,7);assert.deepEqual(scoped,original);
    await client.query("select set_config('app.business_id',$1,true)",[ids.foreignBusiness]);
    assert.equal((await client.query(`select * from mc.current_operational_daily_metrics_for_range($1,$2,$3::date,$4::date,$5::uuid[])`,params)).rowCount,0);
    assert.equal((await client.query(`select has_table_privilege(current_user,'mc.operational_daily_metrics','INSERT') allowed`)).rows[0].allowed,false);
  });
});

test('confirmed financial empty week promotes retained funnel dates older than Statistics history locally',async()=>{
  const old={dateFrom:'2026-05-04',dateTo:'2026-05-10'};
  await context(async client=>{
    await client.query(`update mc.operational_range_requests set status='complete',retryable=false where store_id=$1`,[ids.store]);
    const confirmation=(await client.query(`insert into mc.jobs(business_id,store_id,job_type,deduplication_key,payload,status,outcome,finished_at)
      values($1,$2,'financial_inventory_refresh','cache-empty-test','{"credentialGeneration":1}','succeeded','completed',clock_timestamp()) returning id`,[ids.business,ids.store])).rows[0];
    await client.query(`insert into mc.financial_week_coverage(business_id,store_id,credential_generation,week_start,week_end,check_reasons,coverage_status,inventory_confirmed_at,empty_confirmed_by_job_id)
      values($1,$2,1,$3,$4,ARRAY['test'],'empty',clock_timestamp(),$5)`,[ids.business,ids.store,old.dateFrom,old.dateTo,confirmation.id]);
  });
  const initial=await beginOperationalSync(ids.user,ids.store,{force:true,...old});
  await publish(initial,null,{fetchedAt:new Date('2026-05-11T12:00:00Z'),unknownReturns:true});
  const promoted=await requestOperationalRangeRefresh(ids.user,ids.store,old.dateFrom,old.dateTo,{now:new Date('2026-10-04T12:00:00Z')});
  assert.equal(promoted.queued,35);
  const pending=await beginOperationalSync(ids.user,ids.store,{force:true,...old});
  const sources=await getOperationalCachedSources(ids.user,pending,{now:new Date('2026-10-04T12:00:00Z')});
  assert.equal(sources.funnelRows.length,7);assert.equal(sources.returnsRows.length,7);
  assert.ok(sources.returnsRows.every(row=>row.returnSource==='financial_report'&&row.returnCount===0&&row.returnSum==='0.0000'));
  await publish(pending,sources.returnsRows,{fetchedAt:new Date('2026-10-04T12:00:00Z')});
  const repeated=await requestOperationalRangeRefresh(ids.user,ids.store,old.dateFrom,old.dateTo,{now:new Date('2026-10-04T12:00:00Z')});
  assert.equal(repeated.queued,0);
  await context(client=>client.query(`update mc.operational_range_requests set status='complete',retryable=false where store_id=$1`,[ids.store]));
});

test('inventory invalidation hides saved financial return metrics and never reuses stale evidence',async()=>{
  await context(client=>client.query(`update mc.financial_week_inventory set fetch_status='pending',report_version_id=null,accepted_normalization_id=null,accepted_inventory_checksum=null,accepted_at=null where id=$1`,[inventoryId]));
  const pending=await job(),saved=await cache({...pending,date_from:range.dateFrom,date_to:range.dateTo});
  assert.equal(saved.funnelRows.length,7);assert.equal(saved.returnsRows.length,0);
  const overview=await getOperationalOverviewData(ids.user,ids.store,{periodStart:range.dateFrom,periodEnd:range.dateTo,now});
  assert.ok(overview.rows.filter(row=>row.metric_date>=range.dateFrom).every(row=>row.return_count===null&&row.return_amount===null));
  assert.ok(overview.savedRows.every(row=>row.return_count===null));
  await failOperationalSync(ids.user,pending,'test_cleanup');
  await context(client=>client.query(`update mc.financial_week_inventory set fetch_status='accepted',report_version_id=$2,accepted_normalization_id=$3,accepted_inventory_checksum=inventory_checksum,accepted_at=clock_timestamp() where id=$1`,[inventoryId,firstVersion,firstNormalization]));
});

test('catalog revision and unconfirmed coverage each prevent even financial zero reuse',async()=>{
  await context(client=>client.query(`update mc.stores set catalog_revision=catalog_revision+1 where id=$1`,[ids.store]));
  let pending=await job();assert.equal((await cache({...pending,date_from:range.dateFrom,date_to:range.dateTo})).returnsRows.length,0);
  await failOperationalSync(ids.user,pending,'test_cleanup');
  await context(client=>client.query(`update mc.stores set catalog_revision=catalog_revision-1 where id=$1`,[ids.store]));
  await context(client=>client.query(`update mc.financial_week_coverage set coverage_status='retry' where id=$1`,[coverageId]));
  pending=await job();assert.equal((await cache({...pending,date_from:range.dateFrom,date_to:range.dateTo})).returnsRows.length,0);
  await failOperationalSync(ids.user,pending,'test_cleanup');
  await context(client=>client.query(`update mc.financial_week_coverage set coverage_status='complete' where id=$1`,[coverageId]));
});

test('new current report version requires its exact accepted normalization and replaces old values',async()=>{
  const revised=await context(client=>addVersion(client,2,{returnQuantity:1,unitPrice:'400.1250'}));
  let pending=await job();assert.equal((await cache({...pending,date_from:range.dateFrom,date_to:range.dateTo})).returnsRows.length,0);
  await failOperationalSync(ids.user,pending,'test_cleanup');
  await context(client=>client.query(`update mc.financial_week_inventory set fetch_status='accepted',report_version_id=$2,accepted_normalization_id=$3,accepted_at=clock_timestamp() where id=$1`,[inventoryId,revised.versionId,revised.normalizationId]));
  pending=await job();const refreshed=await cache({...pending,date_from:range.dateFrom,date_to:range.dateTo});
  assert.equal(refreshed.returnsRows.find(row=>row.date==='2026-09-15').returnSum,'400.1250');
  assert.equal(refreshed.returnsRows[0].returnSourceRefs.inventory[0].reportVersionId,revised.versionId);
  await failOperationalSync(ids.user,pending,'test_cleanup');
});

async function splitWeek(from,to,parts){
 return context(async client=>{
  const coverage=(await client.query(`insert into mc.financial_week_coverage(business_id,store_id,credential_generation,week_start,week_end,check_reasons,coverage_status,inventory_confirmed_at)
    values($1,$2,1,$3,$4,ARRAY['split_test'],'complete',clock_timestamp()) returning id`,[ids.business,ids.store,from,to])).rows[0];
  const inventories=[];
  for(const [index,part] of parts.entries()){
   const externalId=String(Date.parse(part.from)+index),checksum=String(index+1).repeat(64);
   const document=(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','weekly_realization',$3,'complete') returning id`,[ids.business,ids.store,randomUUID()])).rows[0];
   const report=(await client.query(`insert into mc.reports(business_id,store_id,external_report_id,period_start,period_end) values($1,$2,$3,$4,$5) returning id`,[ids.business,ids.store,externalId,part.from,part.to])).rows[0];
   const version=(await client.query(`insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version) values($1,$2,$3,$4,1,$5,'wb-finance-v13') returning id`,[ids.business,ids.store,report.id,document.id,checksum])).rows[0];
   const raw={docTypeName:'Возврат',sellerOperName:'Возврат',nmId:'7200001',rrdId:externalId,rrDate:part.to,saleDate:part.from,quantity:'1',retailPriceWithdiscRub:'100',retailAmount:'100',forPay:'100'};
   await client.query(`insert into mc.report_rows(business_id,store_id,report_version_id,external_row_key,row_number,raw_data,row_checksum) values($1,$2,$3,'1',1,$4::jsonb,$5)`,[ids.business,ids.store,version.id,JSON.stringify(raw),checksum]);
   await client.query("update mc.report_versions set status='validated' where id=$1",[version.id]);await client.query("update mc.report_versions set status='accepted',accepted_at=now() where id=$1",[version.id]);await client.query('update mc.reports set current_version_id=$1 where id=$2',[version.id,report.id]);
   const revision=(await client.query('select catalog_revision from mc.stores where id=$1',[ids.store])).rows[0].catalog_revision;
   const normalization=await persistFinancialNormalization(client,{businessId:ids.business,storeId:ids.store,reportVersionId:version.id,catalogRevision:revision});
   const inventory=(await client.query(`insert into mc.financial_week_inventory(business_id,store_id,coverage_id,external_report_id,inventory_checksum,period_start,period_end,fetch_status,report_version_id,accepted_normalization_id,accepted_inventory_checksum,accepted_at)
     values($1,$2,$3,$4,$5,$6,$7,'accepted',$8,$9,$5,now()) returning id`,[ids.business,ids.store,coverage.id,externalId,checksum,part.from,part.to,version.id,normalization.id])).rows[0];inventories.push(inventory.id);
  }
  return inventories;
 });
}
const splitRange={dateFrom:'2026-09-28',dateTo:'2026-10-04',today:'2026-10-07'};
let splitInventories;
const readSplit=options=>context(client=>readFinancialReturnsCache(client,ids.business,ids.store,[{productId:ids.product,nmId:7200001}],options));
test('month-boundary reports jointly cover a week and provide exact returns without Statistics requests',async()=>{
 splitInventories=await splitWeek(splitRange.dateFrom,splitRange.dateTo,[{from:'2026-09-28',to:'2026-09-30'},{from:'2026-10-01',to:'2026-10-04'}]);
 const rows=await readSplit(splitRange);assert.equal(rows.length,7);assert.equal(rows.filter(row=>row.returnCount===1).length,2);assert.equal(rows.filter(row=>row.returnCount===0).length,5);assert.ok(rows.every(row=>row.returnSource==='financial_report'&&row.returnSourceRefs.inventory.length===2));
 for(const row of rows)assert.equal(await context(async client=>(await client.query('select mc.operational_financial_return_refs_current($1,$2,$3::jsonb) valid',[ids.business,ids.store,JSON.stringify(row.returnSourceRefs)])).rows[0].valid),true);
});
test('one invalid report part prevents reuse of the entire split-week evidence',async()=>{
 const original=await context(async client=>(await client.query('select report_version_id,accepted_normalization_id from mc.financial_week_inventory where id=$1',[splitInventories[1]])).rows[0]);
 await context(client=>client.query("update mc.financial_week_inventory set fetch_status='pending' where id=$1",[splitInventories[1]]));assert.deepEqual(await readSplit(splitRange),[]);
 await context(client=>client.query("update mc.financial_week_inventory set fetch_status='accepted',report_version_id=$2,accepted_normalization_id=$3,accepted_inventory_checksum=inventory_checksum,accepted_at=clock_timestamp() where id=$1",[splitInventories[1],original.report_version_id,original.accepted_normalization_id]));assert.equal((await readSplit(splitRange)).length,7);
});
test('a gap between accepted report parts never proves missing days or financial zeros',async()=>{
 await splitWeek('2026-10-26','2026-11-01',[{from:'2026-10-26',to:'2026-10-28'},{from:'2026-10-30',to:'2026-11-01'}]);
 assert.deepEqual(await readSplit({dateFrom:'2026-10-26',dateTo:'2026-11-01',today:'2026-11-02'}),[]);
});
test('month-boundary coverage works in another year without fixed calendar dates',async()=>{
 await splitWeek('2027-03-29','2027-04-04',[{from:'2027-03-29',to:'2027-03-31'},{from:'2027-04-01',to:'2027-04-04'}]);
 const rows=await readSplit({dateFrom:'2027-03-29',dateTo:'2027-04-04',today:'2027-04-05'});assert.equal(rows.length,7);assert.equal(rows.filter(row=>row.returnCount===1).length,2);
});

test.afterEach(async()=>{await context(client=>client.query(`update mc.sync_runs r set status='failed',finished_at=clock_timestamp(),error_code='test_cleanup'
  from mc.sync_streams s where r.stream_id=s.id and s.source_type='operational_sales_funnel' and r.store_id=$1 and r.status='running'`,[ids.store]));});
test.after(async()=>{await pool.end();await rm(root,{recursive:true,force:true});});
