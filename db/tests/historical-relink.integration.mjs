import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';


const url=process.env.HISTORICAL_RELINK_INTEGRATION_DATABASE_URL;
if(!url||!new URL(url).pathname.toLowerCase().includes('test'))throw new Error('Set HISTORICAL_RELINK_INTEGRATION_DATABASE_URL to a disposable database containing test in its name.');
process.env.DATABASE_URL=url;
const {migrate,pool}=await import('../../app/db.mjs');
const {persistFinancialNormalization,reconcileHistoricalCatalogLinks,reconcileHistoricalCatalogs}=await import('../../app/modules/reports/normalization.repository.mjs');
const {completeCatalogSync}=await import('../../app/modules/catalog/catalog.repository.mjs');
const {completeFinancialSync}=await import('../../app/modules/reports/reports.repository.mjs');
const {normalizeFinancialReports}=await import('../../app/modules/reports/finance.mjs');
test.after(async()=>pool.end());
async function context(scope,action){
  const client=await pool.connect();
  try{
    await client.query('begin');
    await client.query("select set_config('app.user_id',$1,true),set_config('app.business_id',$2,true)",[scope.user,scope.businessId]);
    const result=await action(client);await client.query('commit');return result;
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}
async function fixture({fullCatalog=true,articles=[{nmId:800001,saName:'DELETED',barcode:'80000101'}],selectedCount=1}={}){
  const scope={user:randomUUID(),businessId:randomUUID(),storeId:randomUUID()};
  await context(scope,async client=>{
    await client.query(`insert into mc.users(id,display_name) values($1,'Historical owner')`,[scope.user]);
    await client.query(`insert into mc.businesses(id,name) values($1,'Historical test')`,[scope.businessId]);
    await client.query(`insert into mc.memberships(business_id,user_id,role) values($1,$2,'owner')`,[scope.businessId,scope.user]);
    await client.query(`insert into mc.stores(id,business_id,external_account_id,name,status) values($1::uuid,$2,$1::text,'Historical store','active')`,[scope.storeId,scope.businessId]);
    const stream=(await client.query(`insert into mc.sync_streams(business_id,store_id,source_type) values($1,$2,'catalog') returning id`,[scope.businessId,scope.storeId])).rows[0];
    const run=(await client.query(`insert into mc.sync_runs(business_id,store_id,stream_id,status) values($1,$2,$3,$4) returning id`,[scope.businessId,scope.storeId,stream.id,fullCatalog?'succeeded':'failed'])).rows[0];
    const document=(await client.query(`insert into mc.source_documents(business_id,store_id,sync_run_id,origin,document_type,checksum,completeness) values($1,$2,$3,'wb_api','catalog',$4,'complete') returning id`,[scope.businessId,scope.storeId,run.id,randomUUID()])).rows[0];
    const ids=[];
    for(let n=0;n<selectedCount;n++)ids.push((await client.query(`insert into mc.products(business_id,store_id,wb_article,seller_article) values($1,$2,$3,'LIVE') returning id`,[scope.businessId,scope.storeId,700001+n])).rows[0].id);
    await client.query(`select mc.confirm_product_selection($1,$2,$3::uuid[])`,[scope.storeId,document.id,ids]);
    const reportDocument=(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','weekly_realization',$3,'complete') returning id`,[scope.businessId,scope.storeId,randomUUID()])).rows[0];
    const report=(await client.query(`insert into mc.reports(business_id,store_id,external_report_id,period_start,period_end) values($1,$2,$3,'2026-04-06','2026-04-12') returning id`,[scope.businessId,scope.storeId,randomUUID()])).rows[0];
    const version=(await client.query(`insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version) values($1,$2,$3,$4,1,$5,'wb-finance-v13') returning id`,[scope.businessId,scope.storeId,report.id,reportDocument.id,randomUUID()])).rows[0];
    scope.reportVersionId=version.id;
    for(let n=0;n<articles.length;n++)await client.query(`insert into mc.report_rows(business_id,store_id,report_version_id,external_row_key,row_number,raw_data,row_checksum) values($1,$2,$3,$4,$5,$6,$7)`,[scope.businessId,scope.storeId,version.id,String(n),n+1,JSON.stringify(articles[n]),randomUUID()]);
    await client.query(`update mc.report_versions set status='validated' where id=$1`,[version.id]);
    await client.query(`update mc.report_versions set status='accepted',accepted_at=now() where id=$1`,[version.id]);
    await client.query(`update mc.reports set current_version_id=$2 where id=$1`,[report.id,version.id]);
  });
  return scope;
}

const sale={nmId:800001,saName:'DELETED',sku:'80000101',rrDate:'2026-04-08',docTypeName:'Продажа',sellerOperName:'Продажа',quantity:1,retailAmount:'200',acquiringFee:'10',forPay:'190'};

test('maintenance establishes the indexed owner context and recovers existing reports',async()=>{
  await migrate();
  const scope=await fixture({articles:[sale]});
  await context(scope,client=>client.query(`insert into mc.operational_sync_targets(store_id,business_id,requested_by) values($1,$2,$3)`,[scope.storeId,scope.businessId,scope.user]));
  await reconcileHistoricalCatalogs();
  await context(scope,async client=>{
    assert.equal((await client.query(`select historical_deleted from mc.products where store_id=$1 and wb_article=800001`,[scope.storeId])).rows[0].historical_deleted,true);
    assert.equal((await client.query(`select count(*)::int as n from mc.operation_versions where store_id=$1 and product_id is not null and variant_id is not null`,[scope.storeId])).rows[0].n,1);
  });
});

test('returning WB card with two report barcodes preserves both cost identities',async()=>{
  const scope=await fixture({articles:[sale,{...sale,sku:'80000102'}]});
  await context(scope,client=>reconcileHistoricalCatalogLinks(client,scope));
  const before=await context(scope,async client=>{
    const variants=(await client.query(`select v.id,v.product_id,i.identifier_value from mc.variants v join mc.variant_identifiers i on i.variant_id=v.id where v.store_id=$1 order by i.identifier_value`,[scope.storeId])).rows;
    for(const [index,variant] of variants.entries()){
      const cost=(await client.query(`insert into mc.variant_costs(business_id,store_id,product_id,variant_id,effective_from) values($1,$2,$3,$4,'2026-01-01') returning id`,[scope.businessId,scope.storeId,variant.product_id,variant.id])).rows[0];
      const version=(await client.query(`insert into mc.cost_versions(business_id,store_id,cost_id,version_no,unit_cost,origin,changed_by) values($1,$2,$3,1,$4,'manual',$5) returning id`,[scope.businessId,scope.storeId,cost.id,40+index,scope.user])).rows[0];
      await client.query(`update mc.variant_costs set current_version_id=$2 where id=$1`,[cost.id,version.id]);
    }
    return variants;
  });
  const job=await context(scope,async client=>{
    const stream=(await client.query(`select id from mc.sync_streams where store_id=$1 and source_type='catalog'`,[scope.storeId])).rows[0];
    const run=(await client.query(`insert into mc.sync_runs(business_id,store_id,stream_id,status) values($1,$2,$3,'running') returning id`,[scope.businessId,scope.storeId,stream.id])).rows[0];
    return{business_id:scope.businessId,store_id:scope.storeId,stream_id:stream.id,run_id:run.id};
  });
  await completeCatalogSync(scope.user,job,{cards:[{nmId:800001,vendorCode:'RETURNED',title:'Returned card',imageUrl:'https://example.test/product.jpg',variants:[{externalId:'WB-size',sizeLabel:'M',colorLabel:null,attributes:{},barcodes:['80000101','80000102']}]}]});
  await context(scope,async client=>{
    const after=(await client.query(`select v.id,v.product_id,i.identifier_value from mc.variants v join mc.variant_identifiers i on i.variant_id=v.id where v.store_id=$1 order by i.identifier_value`,[scope.storeId])).rows;
    assert.deepEqual(after,before);
    assert.equal((await client.query(`select historical_deleted from mc.products where store_id=$1 and wb_article=800001`,[scope.storeId])).rows[0].historical_deleted,false);
    const costs=(await client.query(`select c.variant_id,cv.unit_cost::text from mc.variant_costs c join mc.cost_versions cv on cv.id=c.current_version_id where c.store_id=$1`,[scope.storeId])).rows;
    assert.equal(costs.length,2);
    for(const [index,variant] of before.entries())assert.equal(Number(costs.find(cost=>cost.variant_id===variant.id).unit_cost),40+index);
  });
});
test('saved report links are rebuilt immutably and emit one financial event',async()=>{
  await migrate();
  const scope=await fixture({articles:[sale]});
  const old=await context(scope,client=>persistFinancialNormalization(client,{...scope,reportVersionId:scope.reportVersionId,catalogRevision:0}));
  await context(scope,async client=>{
    assert.equal((await client.query(`select product_id from mc.operation_versions where report_normalization_id=$1`,[old.id])).rows[0].product_id,null);
    assert.equal((await client.query(`select count(*)::int as n from mc.data_issues where report_normalization_id=$1 and code='financial_product_not_in_catalog' and status='open'`,[old.id])).rows[0].n,1);
  });
  const result=await context(scope,client=>reconcileHistoricalCatalogLinks(client,scope));
  assert.equal(result.normalizedReports,1);assert.equal(result.addedProductIds.length,1);
  await context(scope,async client=>{
    const versions=(await client.query(`select o.product_id,o.variant_id,n.catalog_revision::text from mc.operation_versions o join mc.report_normalizations n on n.id=o.report_normalization_id where n.report_version_id=$1 order by n.catalog_revision`,[scope.reportVersionId])).rows;
    assert.equal(versions.length,2);assert.equal(versions[0].product_id,null);assert.equal(versions[1].product_id,result.addedProductIds[0]);assert.ok(versions[1].variant_id);
    const components=(await client.query(`select category_code,amount_signed::text from mc.financial_components f join mc.operation_versions o on o.id=f.operation_version_id join mc.report_normalizations n on n.id=o.report_normalization_id where n.report_version_id=$1 and n.catalog_revision=1 order by category_code`,[scope.reportVersionId])).rows;
    assert.deepEqual(components.map(x=>[x.category_code,Number(x.amount_signed)]),[['acquiring',-10],['payout',190],['revenue',200]]);
    assert.equal((await client.query(`select count(*)::int as n from mc.cost_versions where store_id=$1`,[scope.storeId])).rows[0].n,0);
    assert.equal((await client.query(`select status from mc.data_issues where report_normalization_id=$1 and code='financial_product_not_in_catalog'`,[old.id])).rows[0].status,'resolved');
  });
  const again=await context(scope,client=>reconcileHistoricalCatalogLinks(client,scope));assert.equal(again.normalizedReports,0);assert.equal(again.changed,false);
});

test('legacy incoming report restores its missing product before normalization',async()=>{
  const scope=await fixture({articles:[]});
  const job=await context(scope,async client=>{
    const stream=(await client.query(`insert into mc.sync_streams(business_id,store_id,source_type) values($1,$2,'financial_reports') returning id`,[scope.businessId,scope.storeId])).rows[0];
    const run=(await client.query(`insert into mc.sync_runs(business_id,store_id,stream_id,status,requested_from,requested_to) values($1,$2,$3,'running','2026-04-06','2026-04-12') returning id`,[scope.businessId,scope.storeId,stream.id])).rows[0];
    return{business_id:scope.businessId,store_id:scope.storeId,stream_id:stream.id,run_id:run.id,date_from:'2026-04-06',date_to:'2026-04-12'};
  });
  const reports=normalizeFinancialReports([{...sale,reportId:987654321,dateFrom:'2026-04-06',dateTo:'2026-04-12',rrdId:1234,currency:'RUB'}]);
  const result=await completeFinancialSync(scope.user,job,{documentId:randomUUID(),reports});assert.equal(result.insertedReports,1);
  await context(scope,async client=>{
    const operation=(await client.query(`select o.product_id,o.variant_id,p.historical_deleted from mc.operation_versions o join mc.products p on p.id=o.product_id join mc.report_rows rr on rr.id=o.report_row_id join mc.report_versions rv on rv.id=rr.report_version_id join mc.reports r on r.id=rv.report_id where r.external_report_id='987654321' and r.store_id=$1`,[scope.storeId])).rows;
    assert.equal(operation.length,1);assert.ok(operation[0].product_id);assert.ok(operation[0].variant_id);assert.equal(operation[0].historical_deleted,true);
  });
});

test('repeated full catalog sync keeps a recovered original WB variant active without revision churn',async()=>{
  const scope=await fixture({articles:[{...sale,nmId:700001,sku:'70000101'}]});
  const variantId=await context(scope,async client=>{
    const product=(await client.query(`select id from mc.products where store_id=$1 and wb_article=700001`,[scope.storeId])).rows[0];
    const variant=(await client.query(`insert into mc.variants(business_id,store_id,product_id,external_variant_id,status) values($1,$2,$3,'old-WB-size','archived') returning id`,[scope.businessId,scope.storeId,product.id])).rows[0];
    await client.query(`insert into mc.variant_identifiers(business_id,store_id,variant_id,identifier_type,identifier_value) values($1,$2,$3,'barcode','70000101')`,[scope.businessId,scope.storeId,variant.id]);
    await client.query(`update mc.products set status='archived' where id=$1`,[product.id]);
    return variant.id;
  });
  await context(scope,client=>reconcileHistoricalCatalogLinks(client,scope));
  for(let n=0;n<2;n++){
    const job=await context(scope,async client=>{
      const stream=(await client.query(`select id from mc.sync_streams where store_id=$1 and source_type='catalog'`,[scope.storeId])).rows[0];
      const run=(await client.query(`insert into mc.sync_runs(business_id,store_id,stream_id,status) values($1,$2,$3,'running') returning id`,[scope.businessId,scope.storeId,stream.id])).rows[0];
      return{business_id:scope.businessId,store_id:scope.storeId,stream_id:stream.id,run_id:run.id};
    });
    await completeCatalogSync(scope.user,job,{cards:[]});
  }
  await context(scope,async client=>{
    assert.equal((await client.query(`select status from mc.variants where id=$1`,[variantId])).rows[0].status,'active');
    assert.equal((await client.query(`select catalog_revision::text from mc.stores where id=$1`,[scope.storeId])).rows[0].catalog_revision,'1');
    assert.equal((await client.query(`select count(*)::int as n from mc.report_normalizations where store_id=$1`,[scope.storeId])).rows[0].n,1);
  });
});

test('fresh WB import with unchanged checksum creates a current-parser source without rewriting v12 evidence',async()=>{
  const scope=await fixture({articles:[]});
  const reports=normalizeFinancialReports([{...sale,reportId:987654322,dateFrom:'2026-04-06',dateTo:'2026-04-12',rrdId:1235,currency:'RUB'}]);
  const source=reports[0],sourceRow=source.rows[0];
  const before=await context(scope,async client=>{
    const document=(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,checksum,completeness) values($1,$2,'wb_api','weekly_realization',$3,'complete') returning id`,[scope.businessId,scope.storeId,randomUUID()])).rows[0];
    const report=(await client.query(`insert into mc.reports(business_id,store_id,external_report_id,period_start,period_end) values($1,$2,$3,$4,$5) returning id`,[scope.businessId,scope.storeId,source.externalReportId,source.periodStart,source.periodEnd])).rows[0];
    const version=(await client.query(`insert into mc.report_versions(business_id,store_id,report_id,document_id,version_no,checksum,parser_version) values($1,$2,$3,$4,1,$5,'wb-finance-v12') returning id`,[scope.businessId,scope.storeId,report.id,document.id,source.checksum])).rows[0];
    const row=(await client.query(`insert into mc.report_rows(business_id,store_id,report_version_id,external_row_key,row_number,raw_data,row_checksum) values($1,$2,$3,$4,1,$5::jsonb,$6) returning id,raw_data,row_checksum`,[scope.businessId,scope.storeId,version.id,sourceRow.externalRowKey,JSON.stringify(sourceRow.rawData),sourceRow.rowChecksum])).rows[0];
    await client.query(`update mc.report_versions set status='validated' where id=$1`,[version.id]);
    await client.query(`update mc.report_versions set status='accepted',accepted_at=now() where id=$1`,[version.id]);
    await client.query(`update mc.reports set current_version_id=$2 where id=$1`,[report.id,version.id]);
    const stream=(await client.query(`insert into mc.sync_streams(business_id,store_id,source_type) values($1,$2,'financial_reports') returning id`,[scope.businessId,scope.storeId])).rows[0];
    const run=(await client.query(`insert into mc.sync_runs(business_id,store_id,stream_id,status,requested_from,requested_to) values($1,$2,$3,'running',$4,$5) returning id`,[scope.businessId,scope.storeId,stream.id,source.periodStart,source.periodEnd])).rows[0];
    return{reportId:report.id,versionId:version.id,row,job:{business_id:scope.businessId,store_id:scope.storeId,stream_id:stream.id,run_id:run.id,date_from:source.periodStart,date_to:source.periodEnd}};
  });
  const documentId=randomUUID();
  const result=await completeFinancialSync(scope.user,before.job,{documentId,reports});
  assert.equal(result.insertedReports,1);
  await context(scope,async client=>{
    const versions=(await client.query(`select id,parser_version,checksum,document_id from mc.report_versions where report_id=$1 order by version_no`,[before.reportId])).rows;
    assert.equal(versions.length,2);
    assert.equal(versions[0].id,before.versionId);
    assert.equal(versions[0].parser_version,'wb-finance-v12');
    assert.equal(versions[1].parser_version,'wb-finance-v13');
    assert.equal(versions[1].checksum,versions[0].checksum);
    assert.equal(versions[1].document_id,documentId);
    assert.notEqual(versions[1].id,before.versionId);
    assert.deepEqual((await client.query(`select id,raw_data,row_checksum from mc.report_rows where report_version_id=$1`,[before.versionId])).rows,[before.row]);
    assert.equal((await client.query(`select current_version_id from mc.reports where id=$1`,[before.reportId])).rows[0].current_version_id,versions[1].id);
    const linked=(await client.query(`select o.product_id,o.variant_id,n.catalog_revision::text from mc.operation_versions o join mc.report_normalizations n on n.id=o.report_normalization_id where n.report_version_id=$1`,[versions[1].id])).rows;
    assert.equal(linked.length,1);assert.ok(linked[0].product_id);assert.ok(linked[0].variant_id);assert.equal(linked[0].catalog_revision,'1');
    assert.equal((await client.query(`select count(*)::int as n from mc.report_normalizations where report_version_id=$1`,[before.versionId])).rows[0].n,0);
  });
});
