import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { previousFourCalendarPeriods } from '../../app/modules/overview/financial-overview.mjs';

const integrationUrl=process.env.P04_FINANCIAL_INTEGRATION_DATABASE_URL;
if(!integrationUrl)throw new Error('Set P04_FINANCIAL_INTEGRATION_DATABASE_URL to a disposable PostgreSQL database whose name contains "test".');
if(!new URL(integrationUrl).pathname.slice(1).toLowerCase().includes('test'))throw new Error('Refusing to run outside a test database.');
process.env.DATABASE_URL=integrationUrl;
const {migrate,pool}=await import('../../app/infrastructure/database/client.mjs');
const {getPublishedFinancialPeriod,getPublishedFinancialPeriodPair}=await import('../../app/modules/calculation/calculation.repository.mjs');
const {getFinancialOverview}=await import('../../app/modules/overview/overview.service.mjs');
const {withPublishedPeriodCache}=await import('../../app/modules/calculation/published-period-cache.mjs');
const {readPublishedSituations}=await import('../../app/modules/calculation/drilldown.repository.mjs');
await migrate();
test.after(()=>pool.end());

// Persist minimal synthetic read-model values. These tests exercise publication
// reads and overview comparison, not the calculation/publication pipeline.
async function fixture({current='100.0000',amounts=['10.0000','20.0000','30.0000','1000.0000'],missing=false,partial=false,methodVersion=null,mixed=false,withTaxFacts=false}={}){
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
    await client.query(`select mc.apply_tariff_period($1,'plus',$2,clock_timestamp())`,[ids.business,`comparison:${randomUUID()}`]);
    await client.query(`insert into mc.products(id,business_id,store_id,wb_article,seller_article) values($1,$2,$3,720001,'Comparison')`,[ids.product,ids.business,ids.store]);
    const catalog=(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness)
      values($1,$2,'wb_api','catalog',$3,'complete') returning id`,[ids.business,ids.store,randomUUID()])).rows[0];
    await client.query(`select mc.confirm_product_selection($1,$2,$3::uuid[])`,[ids.store,catalog.id,[ids.product]]);
    const parser=(await client.query(`select id from mc.method_versions where code='wb_finance_import' order by version_no desc limit 1`)).rows[0].id;
    const method=(await client.query(`select id from mc.method_versions where code='financial_result' and parameters @> '{"targetPeriod":true}'::jsonb
      and ($1::text is null or implementation_version=$1) order by version_no desc limit 1`,[methodVersion])).rows[0].id;
    let taxVersion=null;
    if(withTaxFacts){
      const setting=(await client.query(`insert into mc.tax_settings(business_id,effective_from) values($1,'2026-01-01') returning id`,[ids.business])).rows[0];
      taxVersion=(await client.query(`insert into mc.tax_setting_versions(business_id,tax_setting_id,version_no,regime_code,usn_rate_fraction,vat_mode,changed_by)
        values($1,$2,1,'usn_income',0.06,'exempt',$3) returning id`,[ids.business,setting.id,ids.user])).rows[0].id;
      await client.query(`update mc.tax_settings set current_version_id=$1 where id=$2`,[taxVersion,setting.id]);
    }
    await client.query(`insert into mc.financial_store_event_state(business_id,store_id,next_generation) values($1,$2,3)`,[ids.business,ids.store]);
    const generationIds=new Map();
    let prior=null;
    for(let generationNo=1;generationNo<=(mixed?3:2);generationNo+=1){
      if(generationNo===3)await client.query(`update mc.financial_store_event_state set next_generation=4 where business_id=$1 and store_id=$2`,[ids.business,ids.store]);
      const affectedFrom=generationNo===3?selected.start:periods.at(-1).start;
      const job=(await client.query(`select * from mc.enqueue_job($1,'financial_dates_recalculate',$2,
        jsonb_build_object('schemaVersion',1,'eventGeneration',$3::int,'affectedFrom',$4::text,'affectedTo','2026-09-20','allowsWbApi',false))`,
      [ids.store,`comparison:${randomUUID()}`,generationNo,affectedFrom])).rows[0].id;
      const generation=(await client.query(`insert into mc.financial_daily_generations(
        business_id,store_id,generation_no,source_event_generation,watermark_generation,job_id,affected_from,affected_to,
        parser_method_version_id,result_method_version_id,frozen_input_fingerprint)
        values($1,$2,$3,$3,$3,$4,$8::date,'2026-09-20',$5,$6,$7) returning id`,
      [ids.business,ids.store,generationNo,job,parser,method,randomUUID(),affectedFrom])).rows[0].id;
      generationIds.set(generationNo,generation);
      if(generationNo>=2){
        await client.query(`insert into mc.financial_daily_generation_products(business_id,store_id,generation_id,product_id,selected) values($1,$2,$3,$4,true)`,
        [ids.business,ids.store,generation,ids.product]);
        for(let index=0;index<periods.length;index+=1){
          if(generationNo===3&&index!==0)continue;
          if(missing&&index===4)continue;
          const period=periods[index],amount=generationNo===3?'200.0000':index===0?current:amounts[index-1];
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
          if(taxVersion)await client.query(`insert into mc.financial_daily_tax_facts(business_id,store_id,generation_id,accounting_date,product_id,
            tax_setting_version_id,tax_base_unrounded,tax_numerator_unrounded,tax_rate_fraction,tax_amount_rounded)
            select $1,$2,$3,date,$4,$5,5.5555,$8::numeric,0.06,round($8::numeric,4)
              from generate_series($6::date,least($6::date+1,$7::date),'1 day') date`,
          [ids.business,ids.store,generation,ids.product,taxVersion,period.start,period.end,generationNo===3?'0.44444':'0.33333']);
        }
      }
      await client.query(`update mc.financial_daily_generations set status='succeeded',quality='complete',finished_at=clock_timestamp() where id=$1`,[generation]);
      const publication=(await client.query(`insert into mc.financial_daily_publications(business_id,store_id,publication_no,
        generation_id,prior_publication_id,affected_from,affected_to,source_event_generation,watermark_generation)
        values($1,$2,$3,$4,$5,$6::date,'2026-09-20',$3,$3) returning id`,[ids.business,ids.store,generationNo,generation,prior,affectedFrom])).rows[0].id;
      if(generationNo>=2){
        await client.query(`insert into mc.financial_daily_publication_days(business_id,store_id,publication_id,accounting_date,generation_id)
          select business_id,store_id,$2,accounting_date,generation_id from mc.financial_daily_days
          where (generation_id=$1 and ($4::uuid is null or accounting_date>=$3::date))
            or (generation_id=$4 and accounting_date<$3::date)`,[generation,publication,selected.start,generationNo===3?generationIds.get(2):null]);
        await client.query(`insert into mc.financial_daily_current_publications(business_id,store_id,publication_id) values($1,$2,$3)
          on conflict(business_id,store_id) do update set publication_id=excluded.publication_id`,[ids.business,ids.store,publication]);
      }
      prior=publication;
    }
    assert.equal((await client.query(`select mc.financial_daily_publication_tariff_allowed($1) allowed`,[prior])).rows[0].allowed,true,
      'comparison fixture publication must match its confirmed active tariff scope');
    await client.query('commit');
    return {...ids,publication:prior,periods};
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

test('repository reads all four same-publication periods and latest overview loads each period once',async t=>{
  const ids=await fixture();
  const comparisonPeriods=previousFourCalendarPeriods(ids.periods[0]);
  const pair=await getPublishedFinancialPeriodPair(ids.user,ids.store,{periodStart:'2026-09-14',periodEnd:'2026-09-20',
    previousPeriodStart:'2026-09-07',previousPeriodEnd:'2026-09-13',comparisonPeriods});
  assert.equal(pair.publication_id,ids.publication);
  assert.equal(pair.publication_source,'daily');
  assert.ok(pair.current,'explicit period must retain its persisted daily publication');
  assert.equal(pair.history.length,4);
  assert.equal(pair.history[0],pair.previous);
  assert.deepEqual(pair.history.map(value=>[value.period_start,value.period_end]),comparisonPeriods.map(value=>[value.start,value.end]));
  const overview=await getFinancialOverview(ids.user,ids.store,'2026-09-14');
  assert.equal(overview.comparison.amount,'25.0000');
  assert.equal(overview.comparison.changePercent,'300.0000');
  assert.equal(overview.comparison.comparable,true);
  const queries=[],requests=[];
  const connect=pool.connect.bind(pool);
  t.mock.method(pool,'connect',async()=>{
    const client=await connect(),query=client.query.bind(client);
    t.mock.method(client,'query',(...args)=>{queries.push(args);return query(...args);});
    return client;
  });
  let latestPair;
  const latest=await getFinancialOverview(ids.user,ids.store,null,{
    loadPeriodPair:async(...args)=>{requests.push(args);latestPair=await getPublishedFinancialPeriodPair(...args);return latestPair;}
  });
  assert.deepEqual(requests,[[ids.user,ids.store,{comparisonPeriodCount:4}]]);
  assert.equal(queries.filter(([sql])=>sql==='begin').length,1);
  const mappedReads=queries.filter(([sql])=>sql.includes('day.coverage_complete,day.quality,day.tax_usable'));
  assert.equal(mappedReads.length,1);
  assert.equal(mappedReads[0][1][0],ids.publication);
  assert.deepEqual(JSON.parse(mappedReads[0][1][1]).map(value=>[value.period_start,value.period_end]),ids.periods.map(value=>[value.start,value.end]));
  assert.equal(latestPair.publication_id,ids.publication);
  assert.equal(latestPair.history[0],latestPair.previous);
  assert.equal(latestPair.history.length,4);
  assert.deepEqual(latestPair,pair);
  assert.equal(latest.publicationId,ids.publication);
  assert.equal(latest.comparison.changePercent,'300.0000');
});

test('service keeps signed result changes and absolute negative median denominator',async()=>{
  for(const [input,expected] of [[{current:'-100.0000'},'-500.0000'],
    [{current:'-30.0000',amounts:['-10.0000','-20.0000','-30.0000','-1000.0000']},'-20.0000']]){
    const ids=await fixture(input);
    const overview=await getFinancialOverview(ids.user,ids.store,'2026-09-14');
    assert.equal(overview.displayResult.amount,input.current);
    assert.equal(overview.comparison.changePercent,expected);
  }
});

test('service hides percentages for zero median, missing fourth week and partial fourth week',async()=>{
  for(const [input,reason] of [[{amounts:['-20.0000','-10.0000','10.0000','20.0000']},'previous_zero'],
    [{missing:true},'previous_period_unavailable'],[{partial:true},'incomparable_coverage']]){
    const ids=await fixture(input);
    const overview=await getFinancialOverview(ids.user,ids.store,'2026-09-14');
    assert.equal(overview.displayResult.amount,'100.0000');
    assert.equal(overview.comparison.changePercent,null);
    assert.equal(overview.comparison.reason,reason);
    let latestReads=0;
    const latest=await getFinancialOverview(ids.user,ids.store,null,{
      loadPeriodPair:async(...args)=>{latestReads+=1;return getPublishedFinancialPeriodPair(...args);}
    });
    assert.equal(latestReads,1);
    assert.equal(latest.publicationId,ids.publication);
    assert.equal(latest.displayResult.amount,'100.0000');
    assert.equal(latest.comparison.changePercent,null);
    assert.equal(latest.comparison.reason,reason);
    const other=await fixture();
    assert.equal(await getPublishedFinancialPeriodPair(other.user,ids.store,{periodStart:'2026-09-14',periodEnd:'2026-09-20'}),null);
  }
});

test('latest obsolete publication keeps its frozen method and unavailable result',async()=>{
  const ids=await fixture({methodVersion:'financial-result-v28'});
  const pair=await getPublishedFinancialPeriodPair(ids.user,ids.store,{comparisonPeriodCount:4});
  assert.equal(pair.publication_id,ids.publication);
  assert.equal(pair.method_version,'financial-result-v28');
  assert.equal(pair.method_upgrade_pending,true);
  assert.equal(pair.history.length,4);
  let reads=0;
  const overview=await getFinancialOverview(ids.user,ids.store,null,{
    loadPeriodPair:async(...args)=>{reads+=1;return getPublishedFinancialPeriodPair(...args);}
  });
  assert.equal(reads,1);
  assert.equal(overview.publicationId,ids.publication);
  assert.equal(overview.status,'unavailable');
  assert.equal(overview.displayResult,null);
  assert.equal(overview.comparison.changePercent,null);
  assert.deepEqual(overview.missingReasons,['financial_method_upgrade_pending']);
});

test('situations reuse exact current daily rows while preserving their independent access checks',async t=>{
  const ids=await fixture({current:'-100.0000',withTaxFacts:true});
  const input={storeId:ids.store,publicationId:ids.publication,publicationSource:'daily',
    periodStart:ids.periods[0].start,periodEnd:ids.periods[0].end};
  const standalone=await readPublishedSituations(ids.user,input);
  const queries=[];
  const connect=pool.connect.bind(pool);
  t.mock.method(pool,'connect',async()=>{
    const client=await connect();
    return{query:(...args)=>{queries.push(args);return client.query(...args);},release:(...args)=>client.release(...args)};
  });
  await withPublishedPeriodCache(ids.user,async()=>{
    const money=await getFinancialOverview(ids.user,ids.store,null);
    assert.equal(money.publicationId,input.publicationId);
    queries.length=0;
    const reused=await readPublishedSituations(ids.user,input);
    assert.deepEqual(reused,standalone);
    assert.equal(queries.length,13,'only the four repeated raw-row reads are omitted');
    assert.equal(queries[0][0],'begin isolation level repeatable read read only');
    assert.ok(queries.some(([sql])=>sql.includes('mc.financial_daily_publication_tariff_allowed')));
    assert.ok(queries.some(([sql])=>sql.includes('generation.id=$1 or generation.id in')),
      'all carried generations remain checked, including those outside the requested period');
    const foreign=await fixture();
    await assert.rejects(()=>readPublishedSituations(foreign.user,input),/drilldown_not_found/);
  });
  queries.length=0;
  assert.deepEqual(await readPublishedSituations(ids.user,input),standalone);
  assert.equal(queries.length,17,'outside the request cache, independent readers load their own rows');
});

test('batch ranges preserve mixed generation identity, independent tax rounding, partial and absent periods',async()=>{
  const ids=await fixture({mixed:true,withTaxFacts:true,partial:true});
  const comparisonPeriods=[ids.periods[1],{start:'2026-09-10',end:'2026-09-17'},ids.periods[4],{start:'2026-08-01',end:'2026-08-07'}];
  const pair=await getPublishedFinancialPeriodPair(ids.user,ids.store,{periodStart:ids.periods[0].start,periodEnd:ids.periods[0].end,
    previousPeriodStart:comparisonPeriods[0].start,previousPeriodEnd:comparisonPeriods[0].end,comparisonPeriods});
  assert.equal(pair.history[0],pair.previous);
  assert.equal(pair.current.totals.estimatedUsnTax,'0.8889','current dates use the new generation and round after summing facts');
  assert.equal(pair.previous.totals.estimatedUsnTax,'0.6667','carried dates use their original generation, independently of the current period');
  assert.equal(pair.history[2].quality,'partial');assert.equal(pair.history[3],null);
  const ranges=[ids.periods[0],...comparisonPeriods],envelopes=[pair.current,...pair.history];
  for(let index=0;index<ranges.length;index++){
    const period=ranges[index],single=await getPublishedFinancialPeriod(ids.user,ids.store,period.start,period.end);
    if(envelopes[index]===null){assert.equal(single,null);continue;}
    const comparable=Object.fromEntries(Object.keys(envelopes[index]).map(key=>[key,single[key]]));
    assert.deepEqual(envelopes[index],comparable,'batch and independent period readers agree on every envelope field');
  }
  const input={storeId:ids.store,publicationId:ids.publication,publicationSource:'daily',periodStart:ids.periods[0].start,periodEnd:ids.periods[0].end};
  const standalone=await readPublishedSituations(ids.user,input);
  await withPublishedPeriodCache(ids.user,async()=>{
    await getPublishedFinancialPeriodPair(ids.user,ids.store,{comparisonPeriodCount:4});
    assert.deepEqual(await readPublishedSituations(ids.user,input),standalone);
  });
});

test('request row reuse cannot bypass a tariff change between money and situations',async()=>{
  const ids=await fixture();
  await withPublishedPeriodCache(ids.user,async()=>{
    const money=await getFinancialOverview(ids.user,ids.store,null);
    const client=await pool.connect();
    try{
      await client.query('begin');
      await client.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[ids.user,ids.business]);
      await client.query(`update mc.subscriptions set period_start='2020-01-01',period_end='2020-02-01' where business_id=$1`,[ids.business]);
      await client.query('commit');
    }catch(error){await client.query('rollback');throw error;}finally{client.release();}
    await assert.rejects(()=>readPublishedSituations(ids.user,{storeId:ids.store,publicationId:money.publicationId,
      publicationSource:money.publicationSource,periodStart:money.period.start,periodEnd:money.period.end}),/drilldown_not_found/);
  });
});
