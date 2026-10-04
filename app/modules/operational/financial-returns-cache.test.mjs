import assert from 'node:assert/strict';
import test from 'node:test';
import { financialReturnRows } from './financial-returns-cache.mjs';

const week={id:'coverage',week_start:'2026-09-14',week_end:'2026-09-20',credential_generation:1,proven:true,inventory:[{reportVersionId:'version',reportNormalizationId:'normalization'}]};
const products=[{nmId:101},{nmId:102}];
const options={dateFrom:'2026-09-15',dateTo:'2026-09-16',today:'2026-09-21'};
const event={coverage_id:week.id,id:'operation',report_row_id:'row',report_version_id:'version',report_normalization_id:'normalization',row_checksum:'checksum',
  operation_type:'return',state:'active',quantity:'-2.000000',unit_price:'100.1234',accounting_date:'2026-09-15',nm_id:'101',doc_type_name:'Возврат',seller_oper_name:'Возврат'};

test('confirmed closed financial week reuses returns by accounting date with exact unit price and zeros',()=>{
  const rows=financialReturnRows([week],[event],products,options);
  assert.equal(rows.length,4);
  assert.deepEqual([rows[0].returnCount,rows[0].returnSum,rows[0].returnDateBasis,rows[0].returnAmountBasis],[2,'200.2468','accounting_date','retail_price_with_discount']);
  assert.equal(rows[1].returnCount,0);assert.equal(rows[1].returnSum,'0.0000');
  assert.equal(rows[0].returnSourceRefs.rows[0].reportNormalizationId,'normalization');
});

test('two financial report rows sharing an order remain separate return evidence',()=>{
  const second={...event,id:'second',report_row_id:'second-row',unit_price:'9007199254740993.1250',quantity:'-1'};
  const result=financialReturnRows([week],[event,second],products,options)[0];
  assert.equal(result.returnCount,3);assert.equal(result.returnSum,'9007199254741193.3718');
  assert.equal(result.returnSourceRefs.rows.length,2);
});

test('financial amount overflow remains a missing cache key while exact numeric20,4 boundary is accepted',()=>{
  const overflow={...event,quantity:'-2',unit_price:'9007199254740993.1250'};
  const rows=financialReturnRows([week],[overflow],products,options);
  assert.equal(rows.some(row=>row.nmId===101&&row.date==='2026-09-15'),false);
  assert.equal(rows.length,3);
  assert.ok(rows.every(row=>row.returnCount===0&&row.returnSum==='0.0000'));
  const maximum={...event,quantity:'-1',unit_price:'9999999999999999.9999'};
  assert.equal(financialReturnRows([week],[maximum],products,options)[0].returnSum,'9999999999999999.9999');
  const extra={...event,id:'second',report_row_id:'second-row',quantity:'-1',unit_price:'0.0001'};
  assert.equal(financialReturnRows([week],[maximum,extra],products,options).some(row=>row.nmId===101&&row.date==='2026-09-15'),false);
});

test('incomplete or open weeks never confirm financial zeros',()=>{
  assert.deepEqual(financialReturnRows([{...week,proven:false}],[],products,options),[]);
  assert.deepEqual(financialReturnRows([week],[],products,{...options,today:'2026-09-20'}),[]);
});

test('ambiguous operation, missing money, zero pending price and invalid quantity fail closed for whole week',()=>{
  for(const patch of [{operation_type:'unclassified'},{seller_oper_name:'Отказ'},{unit_price:null},{unit_price:'0'},{quantity:'-1.5'},{quantity:'1'},{state:'withdrawn'}]){
    assert.deepEqual(financialReturnRows([week],[{...event,...patch}],products,options),[]);
  }
});

test('proven sales and logistics are excluded from purchased return aggregates',()=>{
  const rows=financialReturnRows([week],[{...event,operation_type:'sale'},{...event,id:'logistics',operation_type:'service_charge',seller_oper_name:'Логистика'}],products,options);
  assert.ok(rows.every(row=>row.returnCount===0&&row.returnSum==='0.0000'));
});
