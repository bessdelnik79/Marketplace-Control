import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { previousFourCalendarPeriods } from '../../app/modules/overview/financial-overview.mjs';

const integrationUrl=process.env.P04_FINANCIAL_INTEGRATION_DATABASE_URL;
if(!integrationUrl)throw new Error('Set P04_FINANCIAL_INTEGRATION_DATABASE_URL to a disposable PostgreSQL database whose name contains "test".');
if(!new URL(integrationUrl).pathname.slice(1).toLowerCase().includes('test'))throw new Error('Refusing to run outside a test database.');
process.env.DATABASE_URL=integrationUrl;
const {migrate,pool}=await import('../../app/infrastructure/database/client.mjs');
const {getPublishedFinancialPeriodPair}=await import('../../app/modules/calculation/calculation.repository.mjs');
const {getFinancialOverview}=await import('../../app/modules/overview/overview.service.mjs');
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
    await client.query(`insert into mc.products(id,business_id,store_id,wb_article,seller_article) values($1,$2,$3,720001,'Comparison')`,[ids.product,ids.business,ids.store]);
    const parser=(await client.query(`select id from mc.method_versions where code='wb_finance_import' order by version_no desc limit 1`)).rows[0].id;
    const method=(await client.query(`select id from mc.method_versions where code='financial_result' and parameters @> '{"targetPeriod":true}'::jsonb order by version_no desc limit 1`)).rows[0].id;
    await client.query(`insert into mc.financial_store_event_state(business_id,store_id,next_generation) values($1,$2,3)`,[ids.business,ids.store]);
    let prior=null;
    for(let generationNo=1;generationNo<=2;generationNo+=1){
      const job=(await client.query(`select * from mc.enqueue_job($1,'financial_dates_recalculate',$2,
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

test('repository reads all four same-publication periods and service uses positive median',async()=>{
  const ids=await fixture();
  const comparisonPeriods=previousFourCalendarPeriods(ids.periods[0]);
  const pair=await getPublishedFinancialPeriodPair(ids.user,ids.store,{periodStart:'2026-09-14',periodEnd:'2026-09-20',
    previousPeriodStart:'2026-09-07',previousPeriodEnd:'2026-09-13',comparisonPeriods});
  assert.equal(pair.publication_id,ids.publication);
  assert.equal(pair.history.length,4);
  assert.equal(pair.history[0],pair.previous);
  assert.deepEqual(pair.history.map(value=>[value.period_start,value.period_end]),comparisonPeriods.map(value=>[value.start,value.end]));
  const overview=await getFinancialOverview(ids.user,ids.store,'2026-09-14');
  assert.equal(overview.comparison.amount,'25.0000');
  assert.equal(overview.comparison.changePercent,'300.0000');
  assert.equal(overview.comparison.comparable,true);
  const latest=await getFinancialOverview(ids.user,ids.store,null);
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
    const other=await fixture();
    assert.equal(await getPublishedFinancialPeriodPair(other.user,ids.store,{periodStart:'2026-09-14',periodEnd:'2026-09-20'}),null);
  }
});
