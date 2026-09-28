import assert from 'node:assert/strict';
import test from 'node:test';
import {createFinancialDailyGenerationRepository} from './daily-generation.repository.mjs';

test('repository supersedes an older event before loading financial inputs',async()=>{
  const calls=[];
  const client={
    async query(sql){
      calls.push(String(sql));
      if(sql==='begin'||sql==='commit'||sql==='rollback')return{rows:[]};
      if(String(sql).includes('establish_financial_daily_context'))return{rows:[{
        business_id:'business-1',store_id:'store-1',event_generation:'3',watermark_generation:'4',
        affected_from:'2026-09-21',affected_to:'2026-09-27'
      }]};
      throw new Error(`unexpected query: ${sql}`);
    },release(){}
  };
  const repository=createFinancialDailyGenerationRepository({pool:{connect:async()=>client}});
  assert.deepEqual(await repository.build('job-1','lease-1','worker-1'),{superseded:true});
  assert.ok(calls.some(sql=>sql.includes('establish_financial_daily_context')));
  assert.ok(!calls.some(sql=>sql.includes('product_selections')));
});
