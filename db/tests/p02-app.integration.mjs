import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const integrationUrl=process.env.P02_INTEGRATION_DATABASE_URL;
if(!integrationUrl)throw new Error('Set P02_INTEGRATION_DATABASE_URL to a disposable PostgreSQL database whose name contains "test".');
const databaseName=new URL(integrationUrl).pathname.slice(1);
if(!databaseName.toLowerCase().includes('test'))throw new Error('Refusing to run P0.2 integration tests outside a database whose name contains "test".');
process.env.DATABASE_URL=integrationUrl;

const db=await import('../../app/db.mjs');
const {getExpenseState,getTaxState,importExpenses,migrate,pool,saveExpense,saveTaxSetting,voidExpense,voidTaxSetting}=db;

const fixture={
  ownerId:randomUUID(),viewerId:randomUUID(),foreignOwnerId:randomUUID(),
  businessId:randomUUID(),foreignBusinessId:randomUUID(),storeId:randomUUID(),foreignStoreId:randomUUID()
};

await migrate();
await pool.query(`insert into mc.users(id,display_name) values ($1,'P02 owner'),($2,'P02 viewer'),($3,'P02 foreign owner')`,[fixture.ownerId,fixture.viewerId,fixture.foreignOwnerId]);
await pool.query(`insert into mc.businesses(id,name) values ($1,'P02 test'),($2,'P02 foreign test')`,[fixture.businessId,fixture.foreignBusinessId]);
await pool.query(`insert into mc.memberships(business_id,user_id,role) values ($1,$2,'owner'),($1,$3,'viewer'),($4,$5,'owner')`,[fixture.businessId,fixture.ownerId,fixture.viewerId,fixture.foreignBusinessId,fixture.foreignOwnerId]);
await pool.query(`insert into mc.stores(id,business_id,external_account_id,name) values ($1,$2,'p02-test','P02 store'),($3,$4,'p02-foreign-test','P02 foreign store')`,[fixture.storeId,fixture.businessId,fixture.foreignStoreId,fixture.foreignBusinessId]);

test('P0.2 application DB methods preserve versions, atomic imports, roles and tax void semantics',async()=>{
  const input={storeId:fixture.storeId,category:'packaging',amount:'9007199254740991.1234',periodStart:'2026-09-01',periodEnd:'2026-09-01',recognitionMethod:'on_date',description:'Коробки'};
  const created=await saveExpense(fixture.ownerId,input);
  assert.equal(created.changed,true);
  assert.equal((await saveExpense(fixture.ownerId,{...input,expenseId:created.expenseId})).changed,false);
  assert.equal((await voidExpense(fixture.ownerId,{storeId:fixture.storeId,expenseId:created.expenseId})).changed,true);
  const stateAfterVoid=await getExpenseState(fixture.ownerId,fixture.storeId);
  assert.equal(stateAfterVoid.expenses.find(row=>row.id===created.expenseId).state,'voided');

  const rows=[{rowNumber:2,category:'software_services',amount:'1500.2500',periodStart:'2026-09-02',periodEnd:'2026-09-30',recognitionMethod:'evenly_over_period',description:'Сервис'}];
  const checksum='a'.repeat(64),firstImport=await importExpenses(fixture.ownerId,{storeId:fixture.storeId,fileName:'expenses.csv',checksum,rows});
  assert.deepEqual({ok:firstImport.ok,applied:firstImport.applied,skipped:firstImport.skipped},{ok:true,applied:1,skipped:0});
  const repeatedImport=await importExpenses(fixture.ownerId,{storeId:fixture.storeId,fileName:'expenses.csv',checksum,rows});
  assert.deepEqual({ok:repeatedImport.ok,applied:repeatedImport.applied,skipped:repeatedImport.skipped},{ok:true,applied:0,skipped:1});

  const countBefore=Number((await pool.query('select count(*) from mc.expenses where business_id=$1',[fixture.businessId])).rows[0].count);
  const rejected=await importExpenses(fixture.ownerId,{storeId:fixture.storeId,fileName:'broken.csv',checksum:'b'.repeat(64),rows:[...rows,{rowNumber:3,category:'not_allowed',amount:'1',periodStart:'2026-09-03',periodEnd:'2026-09-03',recognitionMethod:'on_date'}]});
  assert.equal(rejected.ok,false);
  assert.equal(Number((await pool.query('select count(*) from mc.expenses where business_id=$1',[fixture.businessId])).rows[0].count),countBefore);

  const concurrentInput={...input,expenseId:created.expenseId,amount:'42.1250',description:'Исправление'};
  const concurrent=await Promise.all([
    saveExpense(fixture.ownerId,concurrentInput),
    saveExpense(fixture.ownerId,concurrentInput)
  ]);
  assert.deepEqual(concurrent.map(result=>result.changed).sort(),[false,true]);
  await assert.rejects(()=>saveExpense(fixture.viewerId,input),/expense_write_forbidden/);
  await assert.rejects(()=>saveExpense(fixture.foreignOwnerId,input),/store_not_found/);

  const oldTax=await saveTaxSetting(fixture.ownerId,{effectiveFrom:'2026-01-01',regimeCode:'usn_income',usnRatePercent:'6',vatMode:'exempt'});
  assert.equal((await saveTaxSetting(fixture.ownerId,{effectiveFrom:'2026-01-01',regimeCode:'usn_income',usnRatePercent:'6.000000',vatMode:'exempt'})).changed,false);
  const latestTax=await saveTaxSetting(fixture.ownerId,{effectiveFrom:'2026-06-01',regimeCode:'usn_income',usnRatePercent:'5.5',vatMode:'general'});
  assert.notEqual(latestTax.settingId,oldTax.settingId);
  await voidTaxSetting(fixture.ownerId,{settingId:latestTax.settingId});
  const taxState=await getTaxState(fixture.ownerId,{asOf:'2026-07-01'});
  assert.equal(taxState.current.setting_id,latestTax.settingId);
  assert.equal(taxState.current.state,'voided');
  assert.equal((await pool.query('select $1::numeric=0.055::numeric as exact',[taxState.current.usn_rate_fraction])).rows[0].exact,true);
  await assert.rejects(()=>saveTaxSetting(fixture.viewerId,{effectiveFrom:'2026-08-01',regimeCode:'usn_income',usnRatePercent:'6',vatMode:'exempt'}),/tax_write_forbidden/);
});

test.after(async()=>{await pool.end();});
