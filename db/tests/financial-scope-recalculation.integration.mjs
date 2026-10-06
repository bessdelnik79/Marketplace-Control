import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {recoverHistoricalCatalog} from '../../app/modules/catalog/historical-catalog.repository.mjs';
import { previousFourCalendarPeriods } from '../../app/modules/overview/financial-overview.mjs';

const integrationUrl=process.env.FINANCIAL_SCOPE_INTEGRATION_DATABASE_URL;
if(!integrationUrl)throw new Error('Set FINANCIAL_SCOPE_INTEGRATION_DATABASE_URL to a disposable PostgreSQL database whose name contains "test".');
if(!new URL(integrationUrl).pathname.slice(1).toLowerCase().includes('test'))throw new Error('Refusing to run outside a test database.');
process.env.DATABASE_URL=integrationUrl;
const {migrate,pool}=await import('../../app/infrastructure/database/client.mjs');


await migrate();
test.after(()=>pool.end());

// Persist minimal synthetic read-model values. These tests exercise publication
// reads and overview comparison, not the calculation/publication pipeline.
async function fixture({current='100.0000',amounts=['10.0000','20.0000','30.0000','1000.0000'],missing=false,partial=false}={}){
  const ids={user:randomUUID(),business:randomUUID(),store:randomUUID(),product:randomUUID()};
  const selected={start:'2026-09-14',end:'2026-09-20'};
  const periods=[selected,...previousFourCalendarPeriods(selected)];
  const client=await pool.connect();
  try{
    await client.query('begin');
    await client.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[ids.user,ids.business]);
    await client.query(`insert into mc.users(id,display_name) values($1,'Comparison owner')`,[ids.user]);
    await client.query(`insert into mc.businesses(id,name) values($1,'Comparison test')`,[ids.business]);
    await client.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[ids.business,ids.user]);
    await client.query(`insert into mc.stores(id,business_id,external_account_id,name,status) values($1,$2,$3,'Comparison store','active')`,[ids.store,ids.business,ids.store]);
    await client.query(`select mc.apply_tariff_period($1,'plus',$2,clock_timestamp())`,[ids.business,`scope:${randomUUID()}`]);
    await client.query(`insert into mc.products(id,business_id,store_id,wb_article,seller_article) values($1,$2,$3,720001,'Comparison')`,[ids.product,ids.business,ids.store]);
    const stream=(await client.query(`insert into mc.sync_streams(business_id,store_id,source_type) values($1,$2,'catalog') returning id`,[ids.business,ids.store])).rows[0];
    const run=(await client.query(`insert into mc.sync_runs(business_id,store_id,stream_id,status) values($1,$2,$3,'succeeded') returning id`,[ids.business,ids.store,stream.id])).rows[0];
    const catalog=(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness,sync_run_id) values($1,$2,'wb_api','catalog',$3,'complete',$4) returning id`,[ids.business,ids.store,randomUUID(),run.id])).rows[0];
    ids.selection=(await client.query(`select mc.confirm_product_selection($1,$2,$3::uuid[]) id`,[ids.store,catalog.id,[ids.product]])).rows[0].id;
    const parser=(await client.query(`select id from mc.method_versions where code='wb_finance_import' order by version_no desc limit 1`)).rows[0].id;
    const method=(await client.query(`select id from mc.method_versions where code='financial_result' and parameters @> '{"targetPeriod":true}'::jsonb order by version_no desc limit 1`)).rows[0].id;
    await client.query(`insert into mc.financial_store_event_state(business_id,store_id,next_generation) values($1,$2,3)`,[ids.business,ids.store]);
    let prior=null;
    for(let generationNo=1;generationNo<=2;generationNo+=1){
      const job=(await client.query(`select * from mc.enqueue_job($1,'financial_recalculation',$2,
        jsonb_build_object('schemaVersion',1,'eventGeneration',$3::int,'affectedFrom','2026-08-17','affectedTo','2026-09-20','allowsWbApi',false))`,
      [ids.store,`comparison:${randomUUID()}`,generationNo])).rows[0].id;
      const generation=(await client.query(`insert into mc.financial_daily_generations(
        business_id,store_id,generation_no,source_event_generation,watermark_generation,job_id,affected_from,affected_to,
        parser_method_version_id,result_method_version_id,frozen_input_fingerprint)
        values($1,$2,$3,$3,$3,$4,'2026-08-17','2026-09-20',$5,$6,$7) returning id`,
      [ids.business,ids.store,generationNo,job,parser,method,randomUUID()])).rows[0].id;
      if(generationNo===2){
        await client.query(`insert into mc.financial_daily_generation_products(business_id,store_id,generation_id,product_id,selected) values($1,$2,$3,$4,true)`,
        [ids.business,ids.store,generation,ids.product]);
        for(let index=0;index<periods.length;index+=1){
          if(missing&&index===4)continue;
          const period=periods[index],amount=index===0?current:amounts[index-1];
          const quality=partial&&index===4?'partial':'complete';
          await client.query(`insert into mc.financial_daily_days(business_id,store_id,generation_id,accounting_date,
            coverage_complete,quality,tax_usable,store_profit_before_tax,selected_profit_before_tax,available_profit_before_tax)
            select $1,$2,$3,date,true,$6,true,0,case when date=$4::date then $7::numeric else 0 end,
              case when date=$4::date then $7::numeric else 0 end
            from generate_series($4::date,$5::date,'1 day') date`,
          [ids.business,ids.store,generation,period.start,period.end,quality,amount]);
          await client.query(`insert into mc.financial_daily_results(business_id,store_id,generation_id,accounting_date,
            category_code,scope,product_id,amount_signed,quality) values($1,$2,$3,$4,'revenue','selected_products',$5,$6,$7)`,
          [ids.business,ids.store,generation,period.start,ids.product,amount,quality]);
          if(quality==='partial')await client.query(`insert into mc.financial_daily_reasons(business_id,store_id,generation_id,accounting_date,scope,reason_code,severity)
            values($1,$2,$3,$4,'selected_products','cost_missing','partial')`,[ids.business,ids.store,generation,period.start]);
        }
      }
      await client.query(`update mc.financial_daily_generations set status='succeeded',quality='complete',finished_at=clock_timestamp() where id=$1`,[generation]);
      const publication=(await client.query(`insert into mc.financial_daily_publications(business_id,store_id,publication_no,
        generation_id,prior_publication_id,affected_from,affected_to,source_event_generation,watermark_generation)
        values($1,$2,$3,$4,$5,'2026-08-17','2026-09-20',$3,$3) returning id`,[ids.business,ids.store,generationNo,generation,prior])).rows[0].id;
      if(generationNo===2){
        await client.query(`insert into mc.financial_daily_publication_days(business_id,store_id,publication_id,accounting_date,generation_id)
          select business_id,store_id,$2,accounting_date,generation_id from mc.financial_daily_days where generation_id=$1`,[generation,publication]);
        await client.query(`insert into mc.financial_daily_current_publications(business_id,store_id,publication_id) values($1,$2,$3)`,[ids.business,ids.store,publication]);
      }
      prior=publication;
    }
    await client.query('commit');
    return {...ids,publication:prior,periods};
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

async function context(ids,action){
  const client=await pool.connect();
  try{
    await client.query('begin');
    await client.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[ids.user,ids.business]);
    const value=await action(client);await client.query('commit');return value;
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}
async function reportEvidence(ids){
  return context(ids,async client=>{
    const document=(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','weekly_realization',$3,'complete') returning id`,[ids.business,ids.store,randomUUID()])).rows[0];
    const report=(await client.query(`insert into mc.reports(business_id,store_id,external_report_id,period_start,period_end) values($1,$2,$3,'2026-09-14','2026-09-20') returning id`,[ids.business,ids.store,randomUUID()])).rows[0];
    const version=(await client.query(`insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version) values($1,$2,$3,$4,1,$5,'wb-finance-v13') returning id`,[ids.business,ids.store,report.id,document.id,randomUUID()])).rows[0];
    await client.query(`insert into mc.report_rows(business_id,store_id,report_version_id,external_row_key,row_number,raw_data,row_checksum) values($1,$2,$3,'1',1,$4::jsonb,$5)`,[ids.business,ids.store,version.id,JSON.stringify({nmId:720002,sku:'72000201',rrDate:'2026-09-16',docTypeName:'Продажа',sellerOperName:'Продажа',quantity:1,retailAmount:'100',forPay:'100'}),randomUUID()]);
    await client.query(`update mc.report_versions set status='validated' where id=$1`,[version.id]);
    await client.query(`update mc.report_versions set status='accepted',accepted_at=now() where id=$1`,[version.id]);
    await client.query(`update mc.reports set current_version_id=$1 where id=$2`,[version.id,report.id]);
    const method=(await client.query(`select id from mc.method_versions where implementation_version='wb-finance-v13'`)).rows[0];
    const normalization=(await client.query(`insert into mc.report_normalizations(business_id,store_id,report_version_id,method_version_id,normalization_key,status) values($1,$2,$3,$4,$5,'succeeded') returning id`,[ids.business,ids.store,version.id,method.id,randomUUID()])).rows[0];
    return{version:version.id,normalization:normalization.id};
  });
}
async function addProduct(ids,{automatic=false}={}){
  return context(ids,async client=>{
    if(automatic){const recovery=await recoverHistoricalCatalog(client,{businessId:ids.business,storeId:ids.store});assert.equal(recovery.addedProductIds.length,1);return recovery.addedProductIds[0];}
    const product=(await client.query(`insert into mc.products(business_id,store_id,wb_article,seller_article) values($1,$2,720002,'Second') returning id`,[ids.business,ids.store])).rows[0].id;
    await client.query(`select mc.add_products_to_selection($1,$2::uuid[])`,[ids.store,[product]]);
    return product;
  });
}
async function emitNarrow(ids,evidence){
  return context(ids,client=>client.query(`select event.*,event.affected_from::text as affected_from,event.affected_to::text as affected_to from mc.emit_financial_input_event($1,$2,'report_updated','2026-09-14','2026-09-20',p_source_report_version_id=>$3,p_source_normalization_id=>$4) event`,[ids.store,randomUUID(),evidence.version,evidence.normalization]).then(result=>result.rows[0]));
}
async function queuedRange(ids){
  return context(ids,client=>client.query(`select id,payload from mc.jobs where store_id=$1 and job_type='financial_dates_recalculate' and status='pending'`,[ids.store]).then(result=>result.rows[0]));
}

test('manual and automatic selection extension include published dates outside report coverage',async()=>{
  for(const automatic of [false,true]){
    const ids=await fixture();await reportEvidence(ids);await addProduct(ids,{automatic});
    const job=await queuedRange(ids);
    assert.deepEqual([job.payload.affectedFrom,job.payload.affectedTo],['2026-08-17','2026-09-20']);
    assert.equal(job.payload.allowsWbApi,false);
    const event=await context(ids,client=>client.query(`select affected_from::text,affected_to::text from mc.financial_input_events where store_id=$1 and event_type='selection_updated' order by event_generation desc limit 1`,[ids.store]).then(result=>result.rows[0]));
    assert.deepEqual(event,{affected_from:'2026-08-17',affected_to:'2026-09-20'});
  }
});

test('failed selection job cannot leave a later narrow report recalculation on the old scope',async()=>{
  const ids=await fixture(),evidence=await reportEvidence(ids);await addProduct(ids);
  const selectionJob=await queuedRange(ids);
  await context(ids,client=>client.query(`update mc.jobs set status='failed',last_error_code='scope_incompatible',finished_at=now() where id=$1`,[selectionJob.id]));
  const event=await emitNarrow(ids,evidence),job=await queuedRange(ids);
  assert.deepEqual([String(event.affected_from).slice(0,10),String(event.affected_to).slice(0,10)],['2026-09-14','2026-09-20']);
  assert.deepEqual([job.payload.affectedFrom,job.payload.affectedTo],['2026-08-17','2026-09-20']);
  assert.notEqual(job.id,selectionJob.id);
});

test('pending narrow work widens on scope mismatch and unchanged selection remains incremental',async()=>{
  const ids=await fixture(),evidence=await reportEvidence(ids);
  await emitNarrow(ids,evidence);const narrow=await queuedRange(ids);
  assert.deepEqual([narrow.payload.affectedFrom,narrow.payload.affectedTo],['2026-09-14','2026-09-20']);
  await addProduct(ids);const widened=await queuedRange(ids);
  assert.equal(widened.id,narrow.id);
  assert.deepEqual([widened.payload.affectedFrom,widened.payload.affectedTo],['2026-08-17','2026-09-20']);
});

test('publication still rejects a manually narrowed generation retaining days from the old selection',async()=>{
  const ids=await fixture(),evidence=await reportEvidence(ids);const second=await addProduct(ids);
  const pending=await queuedRange(ids);
  await context(ids,client=>client.query(`update mc.jobs set status='failed',last_error_code='test_failure',finished_at=now() where id=$1`,[pending.id]));
  const event=await emitNarrow(ids,evidence),job=await queuedRange(ids);
  await context(ids,client=>client.query(`update mc.jobs set payload=jsonb_set(jsonb_set(payload,'{affectedFrom}','"2026-09-14"'),'{affectedTo}','"2026-09-20"') where id=$1`,[job.id]));
  const claimed=(await pool.query(`select * from mc.claim_jobs('scope-guard-worker',array['financial_dates_recalculate'],300,100)`)).rows.find(row=>row.id===job.id);
  assert.ok(claimed);
  const generation=await context(ids,async client=>{
    const methods=(await client.query(`select parser_method_version_id,result_method_version_id from mc.financial_daily_generations where store_id=$1 order by generation_no desc limit 1`,[ids.store])).rows[0];
    const generation=(await client.query(`select * from mc.start_financial_daily_generation($1,$2,'scope-guard-worker',$3,$4,$5,$6)`,[job.id,claimed.lease_token,event.event_generation,randomUUID(),methods.parser_method_version_id,methods.result_method_version_id])).rows[0];
    for(const product of [ids.product,second])await client.query(`insert into mc.financial_daily_generation_products(business_id,store_id,generation_id,product_id,selected) values($1,$2,$3,$4,true)`,[ids.business,ids.store,generation.id,product]);
    await client.query(`update mc.financial_daily_generations set status='succeeded',quality='complete',finished_at=now() where id=$1`,[generation.id]);
    return generation;
  });
  await assert.rejects(()=>context(ids,client=>client.query(`select * from mc.publish_financial_daily_generation($1,$2,'scope-guard-worker',$3,$4)`,[job.id,claimed.lease_token,generation.id,event.event_generation])),/financial_daily_publication_scope_incompatible/);
  const pointer=await context(ids,client=>client.query(`select publication_id from mc.financial_daily_current_publications where store_id=$1`,[ids.store]).then(result=>result.rows[0].publication_id));
  assert.equal(pointer,ids.publication);
});

test('full scope recalculation publishes every prior date under the new frozen selection',async()=>{
  const ids=await fixture();await reportEvidence(ids);const second=await addProduct(ids,{automatic:true});
  const job=await queuedRange(ids);
  const claimed=(await pool.query(`select * from mc.claim_jobs('scope-full-worker',array['financial_dates_recalculate'],300,100)`)).rows.find(row=>row.id===job.id);
  assert.ok(claimed);
  const publication=await context(ids,async client=>{
    const methods=(await client.query(`select parser_method_version_id,result_method_version_id from mc.financial_daily_generations where store_id=$1 order by generation_no desc limit 1`,[ids.store])).rows[0];
    const generation=(await client.query(`select * from mc.start_financial_daily_generation($1,$2,'scope-full-worker',$3,$4,$5,$6)`,[job.id,claimed.lease_token,job.payload.eventGeneration,randomUUID(),methods.parser_method_version_id,methods.result_method_version_id])).rows[0];
    for(const product of [ids.product,second])await client.query(`insert into mc.financial_daily_generation_products(business_id,store_id,generation_id,product_id,selected) values($1,$2,$3,$4,true)`,[ids.business,ids.store,generation.id,product]);
    await client.query(`insert into mc.financial_daily_days(business_id,store_id,generation_id,accounting_date,coverage_complete,quality,tax_usable,store_profit_before_tax,selected_profit_before_tax,available_profit_before_tax)
      select $1,$2,$3,date,false,'unavailable',false,0,0,0 from generate_series($4::date,$5::date,'1 day') date`,[ids.business,ids.store,generation.id,job.payload.affectedFrom,job.payload.affectedTo]);
    await client.query(`update mc.financial_daily_generations set status='succeeded',quality='unavailable',finished_at=now() where id=$1`,[generation.id]);
    return(await client.query(`select * from mc.publish_financial_daily_generation($1,$2,'scope-full-worker',$3,$4)`,[job.id,claimed.lease_token,generation.id,job.payload.eventGeneration])).rows[0];
  });
  assert.equal(publication.prior_publication_id,ids.publication);
  await context(ids,async client=>{
    const mapped=(await client.query(`select count(*)::int as n,min(accounting_date)::text date_from,max(accounting_date)::text date_to,count(distinct generation_id)::int generations from mc.financial_daily_publication_days where publication_id=$1`,[publication.id])).rows[0];
    assert.deepEqual(mapped,{n:35,date_from:'2026-08-17',date_to:'2026-09-20',generations:1});
    assert.equal((await client.query(`select publication_id from mc.financial_daily_current_publications where store_id=$1`,[ids.store])).rows[0].publication_id,publication.id);
    assert.equal((await client.query(`select count(*)::int as n from mc.financial_daily_publication_days where publication_id=$1`,[ids.publication])).rows[0].n,35);
    assert.equal((await client.query(`select mc.financial_publication_selection_changed($1) changed`,[ids.store])).rows[0].changed,false);
  });
});

test('generic migration repair restores every indexed store using an eligible actor fallback',async()=>{
  const source=await readFile(new URL('../migrations/062_financial_scope_recalculation.sql',import.meta.url),'utf8');
  const repair=source.slice(source.indexOf('DO $repair$'),source.indexOf('END $repair$;')+'END $repair$;'.length);
  const fixtures=[];
  for(let index=0;index<2;index++){
    const ids=await fixture();await reportEvidence(ids);await addProduct(ids);
    const pending=await queuedRange(ids);
    await context(ids,async client=>{
      await client.query(`update mc.jobs set status='failed',last_error_code='old_scope_failure',finished_at=now() where id=$1`,[pending.id]);
      const viewer=(await client.query(`insert into mc.users(display_name) values('Former editor') returning id`)).rows[0].id;
      await client.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'viewer')`,[ids.business,viewer]);
      await client.query(`insert into mc.operational_sync_targets(business_id,store_id,requested_by) values($1,$2,$3)`,[ids.business,ids.store,viewer]);
    });
    fixtures.push(ids);
  }
  await pool.query(repair);
  for(const ids of fixtures){
    const job=await queuedRange(ids);
    assert.deepEqual([job.payload.affectedFrom,job.payload.affectedTo],['2026-08-17','2026-09-20']);
    await context(ids,async client=>{
      const event=(await client.query(`select actor_user_id,allows_wb_api from mc.financial_input_events where event_key=$1`,[`financial-scope-repair:062:store:${ids.store}`])).rows[0];
      assert.equal(event.actor_user_id,ids.user);assert.equal(event.allows_wb_api,false);
    });
  }
  await pool.query(repair);
  for(const ids of fixtures)await context(ids,async client=>assert.equal((await client.query(`select count(*)::int as n from mc.financial_input_events where event_key=$1`,[`financial-scope-repair:062:store:${ids.store}`])).rows[0].n,1));
});

test('selection event also includes a proven empty week preceding the publication',async()=>{
  const ids=await fixture();await reportEvidence(ids);
  await context(ids,async client=>{
    const job=(await client.query(`select * from mc.enqueue_job($1,'financial_inventory_refresh',$2,'{"schemaVersion":1,"credentialGeneration":1,"window":{"dateFrom":"2026-08-10","dateTo":"2026-08-16"}}'::jsonb)`,[ids.store,randomUUID()])).rows[0];
    await client.query(`update mc.jobs set status='succeeded',outcome='completed',finished_at=now() where id=$1`,[job.id]);
    await client.query(`insert into mc.financial_week_coverage(business_id,store_id,credential_generation,week_start,week_end,check_reasons,coverage_status,inventory_confirmed_at,last_checked_at,empty_confirmed_by_job_id)
      values($1,$2,1,'2026-08-10','2026-08-16','{annual_backfill}','empty',now(),now(),$3)`,[ids.business,ids.store,job.id]);
  });
  await addProduct(ids);const queued=await queuedRange(ids);
  assert.deepEqual([queued.payload.affectedFrom,queued.payload.affectedTo],['2026-08-10','2026-09-20']);
});

test('scope comparison checks older mapped generations even when the newest generation matches',async()=>{
  const ids=await fixture(),evidence=await reportEvidence(ids),second=await addProduct(ids);
  const job=await queuedRange(ids);
  await context(ids,async client=>{
    const prior=(await client.query(`select parser_method_version_id,result_method_version_id from mc.financial_daily_generations where store_id=$1 order by generation_no desc limit 1`,[ids.store])).rows[0];
    const generation=(await client.query(`insert into mc.financial_daily_generations(business_id,store_id,generation_no,source_event_generation,watermark_generation,job_id,affected_from,affected_to,parser_method_version_id,result_method_version_id,frozen_input_fingerprint)
      values($1,$2,3,3,3,$3,'2026-09-14','2026-09-20',$4,$5,$6) returning id`,[ids.business,ids.store,job.id,prior.parser_method_version_id,prior.result_method_version_id,randomUUID()])).rows[0];
    for(const product of [ids.product,second])await client.query(`insert into mc.financial_daily_generation_products(business_id,store_id,generation_id,product_id,selected) values($1,$2,$3,$4,true)`,[ids.business,ids.store,generation.id,product]);
    await client.query(`insert into mc.financial_daily_days(business_id,store_id,generation_id,accounting_date,coverage_complete,quality,tax_usable,store_profit_before_tax,selected_profit_before_tax,available_profit_before_tax)
      select $1,$2,$3,date,true,'complete',true,0,0,0 from generate_series('2026-09-14'::date,'2026-09-20'::date,'1 day') date`,[ids.business,ids.store,generation.id]);
    await client.query(`update mc.financial_daily_generations set status='succeeded',quality='complete',finished_at=now() where id=$1`,[generation.id]);
    // Deliberately reproduce a historical mixed map using primitive inserts;
    // the production publication function rejects this incompatible successor.
    const publication=(await client.query(`insert into mc.financial_daily_publications(business_id,store_id,publication_no,generation_id,prior_publication_id,affected_from,affected_to,source_event_generation,watermark_generation)
      values($1,$2,3,$3,$4,'2026-09-14','2026-09-20',3,3) returning id`,[ids.business,ids.store,generation.id,ids.publication])).rows[0];
    await client.query(`insert into mc.financial_daily_publication_days(business_id,store_id,publication_id,accounting_date,generation_id)
      select business_id,store_id,$2::uuid,accounting_date,generation_id from mc.financial_daily_publication_days where publication_id=$1 and accounting_date<'2026-09-14'
      union all select business_id,store_id,$2::uuid,accounting_date,generation_id from mc.financial_daily_days where generation_id=$3`,[ids.publication,publication.id,generation.id]);
    await client.query(`update mc.financial_daily_current_publications set publication_id=$2 where store_id=$1`,[ids.store,publication.id]);
    await client.query(`update mc.jobs set status='failed',last_error_code='legacy_mixed_scope',finished_at=now() where id=$1`,[job.id]);
    assert.equal((await client.query(`select mc.financial_publication_selection_changed($1) changed`,[ids.store])).rows[0].changed,true);
  });
  await emitNarrow(ids,evidence);const successor=await queuedRange(ids);
  assert.deepEqual([successor.payload.affectedFrom,successor.payload.affectedTo],['2026-08-17','2026-09-20']);
});
