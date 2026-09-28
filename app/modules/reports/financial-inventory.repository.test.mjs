import assert from 'node:assert/strict';
import test from 'node:test';
import { createFinancialInventoryRepository } from './financial-inventory.repository.mjs';

test('inventory raw summary persistence stays inside the claimed job generation and window',async()=>{
  const calls=[];
  const client={
    query:async(sql,params=[])=>{
      calls.push({sql,params});
      if(String(sql).startsWith('select * from mc.apply_financial_inventory'))return {rows:[{uncovered_weeks:0}]};
      return {rows:[]};
    },
    release:()=>{}
  };
  const repository=createFinancialInventoryRepository({pool:{query:async()=>({rows:[]}),connect:async()=>client}});
  const result=await repository.apply('job-1',7,'lease-1','worker-1',[{
    reportId:'123',summaryRaw:{reportId:'123'}
  }]);
  assert.equal(result.uncovered_weeks,0);
  const rawUpdate=calls.find(({sql})=>String(sql).includes('summary_raw_data=item.value'));
  assert.ok(rawUpdate);
  assert.match(rawUpdate.sql,/wc\.id=wi\.coverage_id/);
  assert.match(rawUpdate.sql,/wc\.credential_generation=\$3/);
  assert.match(rawUpdate.sql,/wc\.week_start<=\(j\.payload->'window'->>'dateTo'\)::date/);
  assert.match(rawUpdate.sql,/wc\.week_end>=\(j\.payload->'window'->>'dateFrom'\)::date/);
  assert.equal(rawUpdate.params[2],7);
  assert.deepEqual(calls.map(({sql})=>sql),[
    'begin',
    'select * from mc.apply_financial_inventory($1,$2,$3,$4,$5::jsonb)',
    rawUpdate.sql,
    'commit'
  ]);
});

test('superseded inventory never mutates raw summaries',async()=>{
  const calls=[];
  const client={
    query:async(sql,params=[])=>{
      calls.push({sql,params});
      if(String(sql).startsWith('select * from mc.apply_financial_inventory'))return {rows:[{superseded:true,uncovered_weeks:0}]};
      return {rows:[]};
    },
    release:()=>{}
  };
  const repository=createFinancialInventoryRepository({pool:{query:async()=>({rows:[]}),connect:async()=>client}});
  const result=await repository.apply('job-1',7,'lease-1','worker-1',[{reportId:'123',summaryRaw:{changed:true}}]);
  assert.equal(result.superseded,true);
  assert.equal(calls.some(({sql})=>String(sql).includes('summary_raw_data=item.value')),false);
  assert.deepEqual(calls.map(({sql})=>sql),[
    'begin',
    'select * from mc.apply_financial_inventory($1,$2,$3,$4,$5::jsonb)',
    'commit'
  ]);
});
