import assert from 'node:assert/strict';
import test from 'node:test';
import {createFinancialDailyGenerationRepository,calculateFinancialPeriods,financialDailyDateOnly} from './daily-generation.repository.mjs';
import {aggregateDailyFinancialGeneration,combineDailyFinancialGenerations} from './daily-generation.mjs';

test('repository preserves PostgreSQL date-only calendar components',()=>{
  assert.equal(financialDailyDateOnly(new Date(2026,8,21)),'2026-09-21');
  assert.equal(financialDailyDateOnly('2026-09-27'),'2026-09-27');
  assert.throws(()=>financialDailyDateOnly('invalid'),/financial_daily_invalid_job/);
});

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

test('mixed report and confirmed-empty weeks keep coverage and include expenses on empty dates',()=>{
  const generations=calculateFinancialPeriods({
    products:['product-1'],
    affectedReports:[{period_start:'2026-06-01',period_end:'2026-06-07',normalization_id:'normalization-1'}],
    affectedEmptyWeeks:[{id:'coverage-1',period_start:'2026-06-08',period_end:'2026-06-14'}],
    components:[{id:'component-1',operationVersionId:'operation-1',categoryCode:'revenue',sourceField:'retailAmount',rawValue:'100.0000',
      amountSigned:'100.0000',productId:'product-1',variantId:null,accountingDate:'2026-06-01',state:'active',operationType:'sale',
      docTypeName:'Продажа',sellerOperName:'Продажа',bonusTypeName:null,scopeCode:'selected_product',classificationStatus:'confirmed'}],
    operations:[],operationLinks:[],costs:[],
    expenses:[{id:'expense-1',productId:null,category:'other_external',amount:'10.0000',periodStart:'2026-06-10',periodEnd:'2026-06-10',
      recognitionMethod:'on_date',state:'active',scopeCode:'store'}],
    taxSettings:[{id:'tax-1',effective_from:'2026-01-01',regime_code:'usn_income',usn_rate_fraction:'0.06',vat_mode:'exempt',state:'active'}]
  });
  const daily=combineDailyFinancialGenerations(generations);
  const result=aggregateDailyFinancialGeneration(daily,{periodStart:'2026-06-01',periodEnd:'2026-06-14'});
  assert.equal(daily.days.length,14);
  assert.ok(daily.days.every(day=>day.coverageComplete));
  assert.equal(daily.days.find(day=>day.accountingDate==='2026-06-10').storeLevelResultBeforeTax,'-10.0000');
  assert.equal(result.quality,'complete');
  assert.equal(result.totals.availableResultBeforeTax,'90.0000');
  assert.equal(result.totals.estimatedUsnTax,'6.0000');
  assert.equal(result.totals.availableResultAfterTax,'84.0000');
  assert.equal(result.totals.netProfit,null);
});
