import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import {loadSkuSourceMetadata} from '../../app/modules/calculation/sku-source-metadata.mjs';

function disposableDatabase(url){
  const parsed=new URL(url),name=decodeURIComponent(parsed.pathname.slice(1));
  if(!['postgres:','postgresql:'].includes(parsed.protocol)||!/(?:^|[_-])test(?:[_-]|$)/i.test(name)||name.includes('/')){
    throw new Error('A disposable PostgreSQL database with a standalone "test" name segment is required.');
  }
  return name;
}
const integrationUrl=process.env.SKU_SOURCE_METADATA_INTEGRATION_DATABASE_URL;
if(!integrationUrl)throw new Error('Set SKU_SOURCE_METADATA_INTEGRATION_DATABASE_URL to an empty disposable PostgreSQL test database.');
const databaseName=disposableDatabase(integrationUrl);
const admin=new pg.Pool({connectionString:integrationUrl,max:1});
const role=`mc_sku_metadata_${randomUUID().replaceAll('-','')}`;
const runtimeUrl=new URL(integrationUrl);
runtimeUrl.searchParams.set('options',`${runtimeUrl.searchParams.get('options')??''} -c role=${role} -c jit=off`.trim());
const runtime=new pg.Pool({connectionString:runtimeUrl.href,max:1});
const operationCount=11320,evidenceCount=360,date='2026-08-03';
let schemaCreated=false,roleCreated=false;
const scopes=[],tables=[];

// Query fixture only: retain the source identities, composite tenant FKs, indexes
// and FORCE RLS policies; unrelated writer triggers/publication setup are omitted.
async function table(name,columns,foreignKeys=[]){
  await admin.query(`create table mc.${name}(id uuid primary key default gen_random_uuid(),business_id uuid not null,
    store_id uuid not null,${columns},unique(business_id,store_id,id)${foreignKeys.map(key=>`,${key}`).join('')})`);
  await admin.query(`alter table mc.${name} enable row level security;
    alter table mc.${name} force row level security;
    create policy tenant_isolation on mc.${name} using(business_id=mc.context_business_id()) with check(business_id=mc.context_business_id());
    create index on mc.${name}(business_id)`);
  tables.push(name);
}
const fk=(column,target)=>`foreign key(business_id,store_id,${column}) references mc.${target}(business_id,store_id,id)`;
async function insert(client,name,rows){
  if(!rows.length)return;
  assert.ok(tables.includes(name));
  const columns=Object.keys(rows[0]).join(',');
  await client.query(`insert into mc.${name}(${columns}) select ${columns} from jsonb_populate_recordset(null::mc.${name},$1::jsonb)`,[JSON.stringify(rows)]);
}
async function tenant(pool,business,action){
  const client=await pool.connect();
  try{
    await client.query('begin');
    await client.query("select set_config('app.business_id',$1,true)",[business]);
    const value=await action(client);await client.query('commit');return value;
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}

test.before(async()=>{
  const database=(await admin.query('select current_database() name')).rows[0].name;
  assert.equal(database,databaseName,'URL parameters must not redirect to another database');
  disposableDatabase(`postgresql://localhost/${encodeURIComponent(database)}`);
  const bootstrap=(await admin.query('select rolcreaterole,rolsuper from pg_roles where rolname=current_user')).rows[0];
  assert.ok(bootstrap.rolcreaterole||bootstrap.rolsuper,'bootstrap role needs CREATEROLE');
  const occupied=(await admin.query(`select exists(select 1 from pg_namespace where nspname not in('public','information_schema')
      and nspname !~ '^pg_') or exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in('r','p','v','m','f','S')) occupied`)).rows[0].occupied;
  assert.equal(occupied,false,'use a dedicated empty database; existing schemas/data are never replaced');
  await admin.query(`create role ${role} nologin nosuperuser nobypassrls`);roleCreated=true;
  await admin.query(`grant ${role} to current_user`);
  await admin.query('create schema mc');schemaCreated=true;
  await admin.query(`create function mc.context_business_id() returns uuid language sql stable as $$
    select nullif(current_setting('app.business_id',true),'')::uuid $$;
    revoke all on schema mc from public;revoke all on function mc.context_business_id() from public`);
  await table('reports','external_report_id text not null');
  await table('report_versions','report_id uuid not null',[fk('report_id','reports')]);
  await table('report_rows',"report_version_id uuid not null,raw_data jsonb not null default '{}'",[fk('report_version_id','report_versions')]);
  await table('report_normalizations','report_version_id uuid not null,method_version_id uuid not null,status text not null',[fk('report_version_id','report_versions')]);
  await table('operation_versions',`report_row_id uuid not null,report_normalization_id uuid not null,operation_type text not null,
    quantity numeric(20,6),accounting_date date not null,product_id uuid,state text not null default 'active' check(state in('active','withdrawn'))`,
    [fk('report_row_id','report_rows'),fk('report_normalization_id','report_normalizations')]);
  await table('financial_components',`operation_version_id uuid not null,method_version_id uuid not null,category_code text not null,
    result_scope_classification text not null,amount_signed numeric(20,4) not null`,[fk('operation_version_id','operation_versions')]);
  await table('financial_daily_generations','parser_method_version_id uuid not null');
  await table('financial_daily_generation_inputs','generation_id uuid not null,report_version_id uuid not null,report_normalization_id uuid not null',
    [fk('generation_id','financial_daily_generations'),fk('report_version_id','report_versions'),fk('report_normalization_id','report_normalizations')]);
  await table('financial_daily_results',`generation_id uuid not null,accounting_date date not null,product_id uuid,category_code text not null,
    scope text not null,amount_signed numeric(20,4) not null`,[fk('generation_id','financial_daily_generations')]);
  await table('financial_daily_evidence',`generation_id uuid not null,daily_result_id uuid not null,financial_component_id uuid,
    source_operation_version_id uuid,report_row_id uuid,contribution_amount numeric(20,4) not null`,
    [fk('generation_id','financial_daily_generations'),fk('daily_result_id','financial_daily_results'),fk('financial_component_id','financial_components'),
      fk('source_operation_version_id','operation_versions'),fk('report_row_id','report_rows')]);
  await table('calculation_inputs','run_id uuid not null,report_version_id uuid,report_normalization_id uuid',
    [fk('report_version_id','report_versions'),fk('report_normalization_id','report_normalizations')]);
  await table('result_lines',`run_id uuid not null,financial_period_result_id uuid not null,accounting_date date not null,
    product_id uuid,category_code text not null,result_scope text not null,amount_signed numeric(20,4) not null`);
  await table('result_evidence',`result_line_id uuid not null,financial_component_id uuid,source_operation_version_id uuid,
    report_row_id uuid,contribution_amount numeric(20,4) not null`,
    [fk('result_line_id','result_lines'),fk('financial_component_id','financial_components'),fk('source_operation_version_id','operation_versions'),fk('report_row_id','report_rows')]);
  await admin.query(`create index operations_by_date on mc.operation_versions(business_id,store_id,accounting_date);
    create index operation_versions_normalization_date on mc.operation_versions(report_normalization_id,accounting_date);
    create index financial_daily_evidence_result_order on mc.financial_daily_evidence(daily_result_id,id);
    create index result_evidence_line on mc.result_evidence(result_line_id)`);
  scopes.push(await seedScope(randomUUID(),randomUUID(),'12'));
  scopes.push(await seedScope(scopes[0].business,randomUUID(),'777'));
  scopes.push(await seedScope(randomUUID(),randomUUID(),'888'));
  await seedBulk(scopes[0]);
  for(const name of tables)await admin.query(`analyze mc.${name}`);
  await admin.query(`grant usage on schema mc to ${role};grant execute on function mc.context_business_id() to ${role};
    grant select on all tables in schema mc to ${role}`);
});

async function seedScope(business,store,reportId){
  const scope={business,store,product:randomUUID(),otherProduct:randomUUID(),method:randomUUID(),otherMethod:randomUUID(),
    generation:randomUUID(),run:randomUUID(),period:randomUUID(),cases:new Map()};
  const base={business_id:business,store_id:store};
  await tenant(admin,business,async client=>{
    await insert(client,'financial_daily_generations',[{...base,id:scope.generation,parser_method_version_id:scope.method}]);
    async function report(externalId){
      const value={report:randomUUID(),version:randomUUID(),row:randomUUID(),normalization:randomUUID()};
      await insert(client,'reports',[{...base,id:value.report,external_report_id:externalId}]);
      await insert(client,'report_versions',[{...base,id:value.version,report_id:value.report}]);
      await insert(client,'report_rows',[{...base,id:value.row,report_version_id:value.version,raw_data:{reportId:externalId}}]);
      await insert(client,'report_normalizations',[{...base,id:value.normalization,report_version_id:value.version,method_version_id:scope.method,status:'succeeded'}]);
      await insert(client,'financial_daily_generation_inputs',[{...base,id:randomUUID(),generation_id:scope.generation,report_version_id:value.version,report_normalization_id:value.normalization}]);
      await insert(client,'calculation_inputs',[{...base,id:randomUUID(),run_id:scope.run,report_version_id:value.version,report_normalization_id:null},
        {...base,id:randomUUID(),run_id:scope.run,report_version_id:null,report_normalization_id:value.normalization}]);
      return value;
    }
    scope.report=await report(reportId);scope.returnReport=await report(reportId==='12'?'300':`${reportId}0`);
    const unfrozen=randomUUID(),failed=randomUUID(),wrongMethod=randomUUID();
    await insert(client,'report_normalizations',[
      {...base,id:unfrozen,report_version_id:scope.report.version,method_version_id:scope.method,status:'succeeded'},
      {...base,id:failed,report_version_id:scope.report.version,method_version_id:scope.method,status:'failed'},
      {...base,id:wrongMethod,report_version_id:scope.report.version,method_version_id:scope.otherMethod,status:'succeeded'}]);
    await insert(client,'financial_daily_generation_inputs',[failed,wrongMethod].map(normalization=>({...base,id:randomUUID(),generation_id:scope.generation,
      report_version_id:scope.report.version,report_normalization_id:normalization})));
    await insert(client,'calculation_inputs',[failed,wrongMethod].map(normalization=>({...base,id:randomUUID(),run_id:scope.run,
      report_version_id:null,report_normalization_id:normalization})));
    async function operation(quantity,options={}){
      const source=options.source??scope.report,id=randomUUID();
      await insert(client,'operation_versions',[{...base,id,report_row_id:source.row,report_normalization_id:options.normalization??source.normalization,
        operation_type:options.type??'sale',quantity,accounting_date:options.date??date,
        product_id:options.product===undefined?scope.product:options.product,state:options.state??'active'}]);
      return id;
    }
    const componentOperation=await operation('2'),direct=await operation('1',{source:scope.returnReport,type:'return'}),priority=await operation('3');
    await addCase(client,scope,'component',{operation:componentOperation,component:true});
    await addCase(client,scope,'direct',{operation:direct,category:'revenue_return',amount:'-20'});
    await addCase(client,scope,'both',{operation:priority,component:true,direct});
    await addCase(client,scope,'null_ids',{operation:null});
    await addCase(client,scope,'wrong_date',{operation:await operation('999',{date:'2026-08-04'})});
    await addCase(client,scope,'wrong_product',{operation:await operation('999',{product:scope.otherProduct})});
    await addCase(client,scope,'withdrawn',{operation:await operation('999',{state:'withdrawn'})});
    await addCase(client,scope,'unfrozen',{operation:await operation('999',{normalization:unfrozen})});
    await addCase(client,scope,'failed',{operation:await operation('999',{normalization:failed})});
    await addCase(client,scope,'wrong_method',{operation:await operation('999',{normalization:wrongMethod}),component:true});
    await addCase(client,scope,'wrong_row',{operation:componentOperation,reportRow:scope.returnReport.row});
    await addCase(client,scope,'store',{operation:await operation(null,{product:null,type:'service_charge'}),component:true,product:null,category:'storage',amount:'-5'});
  });
  return scope;
}

async function addCase(client,scope,name,{operation,component=false,direct=null,category='revenue',amount='100',product=scope.product,reportRow=null,evidence=true}){
  const base={business_id:scope.business,store_id:scope.store},componentId=component?randomUUID():null;
  if(component)await insert(client,'financial_components',[{...base,id:componentId,operation_version_id:operation,method_version_id:scope.method,
    category_code:category,result_scope_classification:product===null?'store':'selected_product',amount_signed:amount}]);
  const value={category,product,daily:randomUUID(),legacy:randomUUID()};scope.cases.set(name,value);
  await insert(client,'financial_daily_results',[{...base,id:value.daily,generation_id:scope.generation,accounting_date:date,product_id:product,
    category_code:category,scope:product===null?'store':'product',amount_signed:amount}]);
  await insert(client,'result_lines',[{...base,id:value.legacy,run_id:scope.run,financial_period_result_id:scope.period,accounting_date:date,product_id:product,
    category_code:category,result_scope:product===null?'store':'selected_product',amount_signed:amount}]);
  if(evidence){
    const source={...base,financial_component_id:componentId,source_operation_version_id:component?direct:operation,report_row_id:reportRow,contribution_amount:amount};
    await insert(client,'financial_daily_evidence',[{...source,id:randomUUID(),generation_id:scope.generation,daily_result_id:value.daily}]);
    await insert(client,'result_evidence',[{...source,id:randomUUID(),result_line_id:value.legacy}]);
  }
}

async function seedBulk(scope){
  await tenant(admin,scope.business,async client=>{
    const operations=(await client.query(`insert into mc.operation_versions(business_id,store_id,report_row_id,report_normalization_id,
      operation_type,quantity,accounting_date,product_id) select $1,$2,$3,$4,'sale',2,$5,$6 from generate_series(1,$7::int) returning id`,
      [scope.business,scope.store,scope.report.row,scope.report.normalization,date,scope.product,operationCount])).rows.slice(0,evidenceCount);
    await addCase(client,scope,'bulk',{operation:null,amount:String(evidenceCount*100),evidence:false});
    const base={business_id:scope.business,store_id:scope.store},value=scope.cases.get('bulk');
    const components=operations.map(operation=>({...base,id:randomUUID(),operation_version_id:operation.id,method_version_id:scope.method,
      category_code:'revenue',result_scope_classification:'selected_product',amount_signed:'100'}));
    await insert(client,'financial_components',components);
    await insert(client,'financial_daily_evidence',components.map(component=>({...base,id:randomUUID(),generation_id:scope.generation,daily_result_id:value.daily,
      financial_component_id:component.id,source_operation_version_id:null,report_row_id:null,contribution_amount:'100'})));
    await insert(client,'result_evidence',components.map(component=>({...base,id:randomUUID(),result_line_id:value.legacy,
      financial_component_id:component.id,source_operation_version_id:null,report_row_id:null,contribution_amount:'100'})));
  });
}

function modelFor(source,scope,names){
  const groups=names.map(name=>{
    const value=scope.cases.get(name);
    const ref=source==='daily'?{source,dailyResultId:value.daily,generationId:scope.generation,accountingDate:date}:
      {source,resultLineId:value.legacy,runId:scope.run,periodResultId:scope.period};
    return {groupKey:name,categoryCode:value.category,product:value.product,lineRefs:[ref,{...ref}]};
  });
  return {items:[{productId:scope.product,quality:'complete',groups:groups.filter(group=>group.product!==null)}],storeLines:groups.filter(group=>group.product===null)};
}
async function read(source,{scope=scopes[0],names=['component','direct','both','store'],business=scope.business,store=scope.store,tenantBusiness=business,mutate,explain=false}={}){
  const model=modelFor(source,scope,names);mutate?.(model);
  return tenant(runtime,tenantBusiness,async client=>{
    const captured=[];
    await loadSkuSourceMetadata({query:async(sql,args)=>{
      const result=await client.query(sql,args);captured.push({sql,args,rows:result.rows});return result;
    }},{context:{storeId:store,publication:{source}},model,businessId:business});
    assert.equal(captured.length,1,'exercise the actual batched repository query');
    const query=captured[0];
    const plan=explain?(await client.query(`explain(analyze,buffers,format json) ${query.sql}`,query.args)).rows[0]['QUERY PLAN'][0]:null;
    return {model,rows:query.rows,plan};
  });
}

test('database guard requires a standalone test segment',()=>{
  for(const name of ['marketplace_control','contest','latest','testproduction','productiontest'])assert.throws(()=>disposableDatabase(`postgresql://localhost/${name}`),/standalone/);
  for(const name of ['test','mc_metadata_test','test_metadata','mc-metadata-test'])assert.equal(disposableDatabase(`postgresql://localhost/${name}`),name);
});
test('runtime is a read-only ordinary role and every fixture table enforces FORCE RLS',async()=>{
  const actual=(await runtime.query('select rolname,rolsuper,rolbypassrls from pg_roles where rolname=current_user')).rows[0];
  assert.equal(actual.rolname,role);assert.equal(actual.rolsuper,false);assert.equal(actual.rolbypassrls,false);
  const security=(await runtime.query(`select c.relname,c.relrowsecurity,c.relforcerowsecurity,
    has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE') can_write from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='mc' and c.relkind='r'`)).rows;
  assert.equal(security.length,tables.length);
  for(const row of security){assert.equal(row.relrowsecurity,true);assert.equal(row.relforcerowsecurity,true);assert.equal(row.can_write,false);}
  assert.equal((await runtime.query('select * from mc.operation_versions')).rows.length,0,'missing tenant context cannot enumerate sources');
});
test('daily and legacy metadata prefer the component ID and deduplicate exact evidence and quantities',async()=>{
  for(const source of ['daily','legacy']){
    const {model,rows}=await read(source);
    assert.equal(rows.length,4);
    assert.deepEqual(model.items[0].reportIds,['12','300']);
    assert.equal(model.items[0].salesCount,5);assert.equal(model.items[0].returnsCount,1);
    assert.deepEqual(model.storeLines[0].reportIds,['12']);
    assert.equal(rows.find(row=>row.group_key==='both').quantity,'3.000000','a second direct ID cannot replace the component source');
  }
});
test('null, stale, unfrozen and mismatched source evidence leaves both quantities unknown',async()=>{
  for(const source of ['daily','legacy']){
    const {model,rows}=await read(source,{names:['null_ids','wrong_date','wrong_product','withdrawn','unfrozen','failed','wrong_method','wrong_row']});
    assert.deepEqual(rows,[]);assert.deepEqual(model.items[0].reportIds,[]);
    assert.equal(model.items[0].salesCount,null);assert.equal(model.items[0].returnsCount,null);
  }
});
test('tenant, store and exact owner/date/period boundaries reject foreign references',async()=>{
  for(const source of ['daily','legacy']){
    for(const foreign of scopes.slice(1)){
      const {model,rows}=await read(source,{scope:foreign,names:['component'],business:scopes[0].business,store:scopes[0].store});
      assert.deepEqual(rows,[]);assert.deepEqual(model.items[0].reportIds,[]);assert.equal(model.items[0].salesCount,null);
    }
    assert.deepEqual((await read(source,{tenantBusiness:scopes[2].business})).rows,[],'RLS rejects an otherwise valid explicit business argument');
    for(const field of source==='daily'?['generationId','accountingDate']:['runId','periodResultId']){
      const {rows}=await read(source,{names:['component'],mutate:model=>{
        for(const ref of model.items[0].groups[0].lineRefs)ref[field]=field==='accountingDate'?'2026-08-04':randomUUID();
      }});
      assert.deepEqual(rows,[],`${source} ${field} must match the saved publication`);
    }
  }
});
function planNodes(node){return [node,...(node.Plans??[]).flatMap(planNodes)];}
for(const source of ['daily','legacy'])test(`${source} uses bounded indexed operation ID lookups under FORCE RLS`,async t=>{
  assert.equal((await runtime.query('show enable_seqscan')).rows[0].enable_seqscan,'on','use the default planner');
  const {model,rows,plan}=await read(source,{names:['bulk'],explain:true});
  assert.equal(rows.length,evidenceCount);assert.deepEqual(model.items[0].reportIds,['12']);
  assert.equal(model.items[0].salesCount,evidenceCount*2);assert.equal(model.items[0].returnsCount,0);
  const scans=planNodes(plan.Plan).filter(node=>node['Relation Name']==='operation_versions'&&node['Actual Loops']>0);
  assert.ok(scans.length>0,'the captured query must actually access operation_versions');
  t.diagnostic(JSON.stringify({source,evidenceRows:rows.length,executionMs:plan['Execution Time'],operationScans:scans.map(node=>({
    type:node['Node Type'],index:node['Index Name'],condition:node['Index Cond'],loops:node['Actual Loops'],rows:node['Actual Rows'],
    removed:node['Rows Removed by Filter']??0,buffers:(node['Shared Hit Blocks']??0)+(node['Shared Read Blocks']??0)}))}));
  for(const scan of scans){
    assert.ok(['Index Scan','Index Only Scan','Bitmap Heap Scan'].includes(scan['Node Type']),`operation lookup must be indexed: ${scan['Node Type']}`);
    const conditions=planNodes(scan).map(node=>node['Index Cond']??'').join(' ');
    assert.match(conditions,/\bid\s*=/,'an ID condition, not just date/product or tenant, must drive the index');
  }
  const visited=scans.reduce((sum,node)=>sum+((node['Actual Rows']??0)+(node['Rows Removed by Filter']??0))*(node['Actual Loops']??0),0);
  const lookups=scans.reduce((sum,node)=>sum+node['Actual Loops'],0);
  // The default planner may repeat a lookup for outer refs/normalizations. Its
  // work per lookup must remain one ID match, regardless of join multiplicity.
  assert.ok(visited<=lookups,`at most one operation per ID lookup expected; visited ${visited} rows in ${lookups} lookups`);
});

test.after(async()=>{
  try{
    await runtime.end();
    if(schemaCreated)await admin.query('drop schema mc cascade');
    if(roleCreated){await admin.query(`drop owned by ${role}`);await admin.query(`drop role ${role}`);}
  }finally{await admin.end();}
});
