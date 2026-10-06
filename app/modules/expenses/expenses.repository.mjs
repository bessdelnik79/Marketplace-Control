import { randomUUID } from 'node:crypto';
import { withOwnedBusinessContext } from '../../infrastructure/database/client.mjs';
import { uuidPattern, exactDate, cleanText } from '../../infrastructure/database/input-validation.mjs';

const expenseCategories=new Set(['packaging','external_promotion','agency_services','software_services','other_external']);
const recognitionMethods=new Set(['on_date','evenly_over_period']);
const exactPositiveAmount=value=>{
  const text=String(value??'').trim().replace(',','.');
  if(!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/.test(text)||/^0(?:\.0{1,4})?$/.test(text))return null;
  const[whole,fraction='']=text.split('.');return`${whole}.${fraction.padEnd(4,'0')}`;
};
export async function getExpenseState(userId,storeId){
  return withOwnedBusinessContext(userId,async(client,businessId)=>{
    const store=(await client.query(`select id from mc.stores where business_id=$1 and id=$2 and status<>'archived' and exists(select 1 from mc.active_profile_stores a where a.business_id=$1 and a.store_id=$2)`,[businessId,storeId])).rows[0];
    if(!store)throw new Error('store_not_found');
    const products=(await client.query(
      `select p.id,p.wb_article::text,p.seller_article,p.title
         from mc.active_profile_products i
         join mc.products p on (p.business_id,p.store_id,p.id)=(i.business_id,i.store_id,i.product_id)
        where i.business_id=$1 and i.store_id=$2 order by coalesce(p.title,p.seller_article),p.wb_article`,[businessId,storeId]
    )).rows;
    const expenses=(await client.query(
      `select e.id,e.product_id,e.external_entry_key,e.created_at,v.id as version_id,v.version_no,v.category,
              v.amount::text,v.period_start,v.period_end,v.channel_name,v.description,v.recognition_method,v.state,v.origin,v.created_at as version_created_at,
              p.wb_article::text,p.seller_article,p.title
         from mc.expenses e
         join mc.expense_versions v on (v.business_id,v.store_id,v.expense_id,v.id)=(e.business_id,e.store_id,e.id,e.current_version_id)
         left join mc.products p on (p.business_id,p.store_id,p.id)=(e.business_id,e.store_id,e.product_id)
        where e.business_id=$1 and e.store_id=$2 and (e.product_id is null or exists(select 1 from mc.active_profile_products a where a.business_id=e.business_id and a.store_id=e.store_id and a.product_id=e.product_id))
        order by v.period_start desc,v.created_at desc,e.id`,[businessId,storeId]
    )).rows;
    const history=(await client.query(
      `select v.id as version_id,v.expense_id,v.version_no,v.category,v.amount::text,v.period_start,v.period_end,
              v.channel_name,v.description,v.recognition_method,v.state,v.origin,v.created_at
         from mc.expense_versions v join mc.expenses e on (e.business_id,e.store_id,e.id)=(v.business_id,v.store_id,v.expense_id)
        where v.business_id=$1 and v.store_id=$2 and (e.product_id is null or exists(select 1 from mc.active_profile_products a where a.business_id=e.business_id and a.store_id=e.store_id and a.product_id=e.product_id)) order by v.created_at desc,v.version_no desc`,[businessId,storeId]
    )).rows;
    const lastImport=(await client.query(
      `select b.id,d.external_document_id as file_name,b.status,b.created_at,b.applied_at,
              count(r.id)::int as total_rows,count(*) filter(where r.status='applied')::int as applied_rows,
              count(*) filter(where r.status in ('skipped','duplicate'))::int as skipped_rows,
              count(*) filter(where r.status='invalid')::int as invalid_rows
         from mc.import_batches b join mc.source_documents d on (d.business_id,d.store_id,d.id)=(b.business_id,b.store_id,b.document_id)
         left join mc.import_rows r on (r.business_id,r.store_id,r.batch_id)=(b.business_id,b.store_id,b.id)
        where b.business_id=$1 and b.store_id=$2 and b.kind='expenses'
        group by b.id,d.external_document_id,b.status,b.created_at,b.applied_at order by b.created_at desc limit 1`,[businessId,storeId]
    )).rows[0]??null;
    return{products,expenses,history,lastImport,summary:{active:expenses.filter(row=>row.state==='active').length,voided:expenses.filter(row=>row.state==='voided').length}};
  });
}

function validateExpenseInput(input){
  const category=String(input.category??'').trim(),amount=exactPositiveAmount(input.amount),periodStart=exactDate(input.periodStart),periodEnd=exactDate(input.periodEnd??input.periodStart),recognitionMethod=String(input.recognitionMethod??'').trim();
  const productId=String(input.productId??'').trim()||null,channelName=cleanText(input.channelName,120),description=cleanText(input.description,500);
  if(!expenseCategories.has(category))throw new Error('expense_category_invalid');
  if(!amount)throw new Error('expense_amount_invalid');
  if(!periodStart||!periodEnd||periodEnd<periodStart)throw new Error('expense_period_invalid');
  if(!recognitionMethods.has(recognitionMethod)||(recognitionMethod==='on_date'&&periodStart!==periodEnd))throw new Error('expense_recognition_invalid');
  if(productId&&!uuidPattern.test(productId))throw new Error('expense_product_invalid');
  if(channelName===null||description===null)throw new Error('expense_text_invalid');
  return{category,amount,periodStart,periodEnd,recognitionMethod,productId,channelName:channelName||null,description:description||null};
}

export async function saveExpense(userId,{storeId,expenseId,...input}){
  const value=validateExpenseInput(input),id=String(expenseId??'').trim()||null;
  if(id&&!uuidPattern.test(id))throw new Error('expense_id_invalid');
  return withOwnedBusinessContext(userId,async(client,businessId,role)=>{
    if(!['owner','editor'].includes(role))throw new Error('expense_write_forbidden');
    const store=(await client.query(`select id from mc.stores where business_id=$1 and id=$2 and status='active' and exists(select 1 from mc.active_profile_stores a where a.business_id=$1 and a.store_id=$2)`,[businessId,storeId])).rows[0];if(!store)throw new Error('store_not_found');
    if(value.productId){const product=(await client.query(`select product_id from mc.active_profile_products where business_id=$1 and store_id=$2 and product_id=$3`,[businessId,storeId,value.productId])).rows[0];if(!product)throw new Error('expense_product_invalid');}
    let expense=id?(await client.query(`select id,product_id,current_version_id from mc.expenses where business_id=$1 and store_id=$2 and id=$3 for update`,[businessId,storeId,id])).rows[0]:null;
    if(id&&!expense)throw new Error('expense_not_found');
    if(expense&&expense.product_id!==value.productId)throw new Error('expense_scope_immutable');
    if(!expense){const createdId=randomUUID();expense=(await client.query(
      `insert into mc.expenses(id,business_id,store_id,product_id,external_entry_key) values($1,$2,$3,$4,$5) returning id,product_id,current_version_id`,
      [createdId,businessId,storeId,value.productId,`manual:${createdId}`]
    )).rows[0];}
    const current=expense.current_version_id?(await client.query(`select category,amount::text,period_start::text,period_end::text,channel_name,description,recognition_method,state from mc.expense_versions where id=$1`,[expense.current_version_id])).rows[0]:null;
    if(current&&current.state==='active'&&current.category===value.category&&exactPositiveAmount(current.amount)===value.amount&&current.period_start===value.periodStart&&current.period_end===value.periodEnd&&(current.channel_name??null)===value.channelName&&(current.description??null)===value.description&&current.recognition_method===value.recognitionMethod)return{expenseId:expense.id,versionId:expense.current_version_id,changed:false};
    const versionNo=(await client.query(`select coalesce(max(version_no),0)+1 as n from mc.expense_versions where expense_id=$1`,[expense.id])).rows[0].n;
    const version=(await client.query(
      `insert into mc.expense_versions(business_id,store_id,expense_id,version_no,category,amount,period_start,period_end,channel_name,description,recognition_method,state,origin,changed_by)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active','manual',$12) returning id`,
      [businessId,storeId,expense.id,versionNo,value.category,value.amount,value.periodStart,value.periodEnd,value.channelName,value.description,value.recognitionMethod,userId]
    )).rows[0];
    await client.query(`update mc.expenses set current_version_id=$1 where id=$2`,[version.id,expense.id]);
    return{expenseId:expense.id,versionId:version.id,changed:true};
  });
}

export async function voidExpense(userId,{storeId,expenseId}){
  if(!uuidPattern.test(String(expenseId??'')))throw new Error('expense_id_invalid');
  return withOwnedBusinessContext(userId,async(client,businessId,role)=>{
    if(!['owner','editor'].includes(role))throw new Error('expense_write_forbidden');
    const row=(await client.query(
      `select e.id,e.current_version_id,v.* from mc.expenses e join mc.expense_versions v on v.id=e.current_version_id
        where e.business_id=$1 and e.store_id=$2 and e.id=$3
          and exists(select 1 from mc.active_profile_stores a where a.business_id=e.business_id and a.store_id=e.store_id)
          and (e.product_id is null or exists(select 1 from mc.active_profile_products a where a.business_id=e.business_id and a.store_id=e.store_id and a.product_id=e.product_id)) for update of e`,[businessId,storeId,expenseId]
    )).rows[0];if(!row)throw new Error('expense_not_found');if(row.state==='voided')return{expenseId,versionId:row.current_version_id,changed:false};
    const versionNo=(await client.query(`select coalesce(max(version_no),0)+1 as n from mc.expense_versions where expense_id=$1`,[expenseId])).rows[0].n;
    const version=(await client.query(
      `insert into mc.expense_versions(business_id,store_id,expense_id,version_no,category,amount,currency,period_start,period_end,channel_name,description,recognition_method,state,origin,changed_by)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'voided','manual',$13) returning id`,
      [businessId,storeId,expenseId,versionNo,row.category,row.amount,row.currency,row.period_start,row.period_end,row.channel_name,row.description,row.recognition_method,userId]
    )).rows[0];await client.query(`update mc.expenses set current_version_id=$1 where id=$2`,[version.id,expenseId]);return{expenseId,versionId:version.id,changed:true};
  });
}

const expenseRowError=(rowNumber,code,details={})=>({rowNumber,code,...(Object.keys(details).length?{details}:{})});
const expenseComparable=value=>JSON.stringify([value.productId??null,value.category,value.amount,value.periodStart,value.periodEnd,value.recognitionMethod,value.channelName??null,value.description??null]);

export async function importExpenses(userId,{storeId,fileName,checksum,rows}){
  const cleanName=String(fileName??'').trim().slice(0,255),cleanChecksum=String(checksum??'').trim().toLowerCase();
  if(!storeId||!cleanName||!Array.isArray(rows)||!rows.length||rows.length>10000||!/^[a-f0-9]{64}$/.test(cleanChecksum))throw new Error('expense_import_invalid');
  return withOwnedBusinessContext(userId,async(client,businessId,role)=>{
    if(!['owner','editor'].includes(role))throw new Error('expense_write_forbidden');
    const store=(await client.query(`select id from mc.stores where business_id=$1 and id=$2 and status='active' and exists(select 1 from mc.active_profile_stores a where a.business_id=$1 and a.store_id=$2)`,[businessId,storeId])).rows[0];if(!store)throw new Error('store_not_found');
    const document=(await client.query(
      `insert into mc.source_documents(business_id,store_id,origin,document_type,external_document_id,checksum,completeness)
       values($1,$2,'user_file','additional_expenses',$3,$4,'unknown') returning id`,[businessId,storeId,cleanName,cleanChecksum]
    )).rows[0];
    const batch=(await client.query(
      `insert into mc.import_batches(business_id,store_id,document_id,kind,uploaded_by,status,column_mapping)
       values($1,$2,$3,'expenses',$4,'validating',$5::jsonb) returning id`,[businessId,storeId,document.id,userId,JSON.stringify({fileName:cleanName,checksum:cleanChecksum})]
    )).rows[0];
    const products=(await client.query(
      `select p.id,p.wb_article::text from mc.active_profile_products i join mc.products p on (p.business_id,p.store_id,p.id)=(i.business_id,i.store_id,i.product_id)
        where i.business_id=$1 and i.store_id=$2`,[businessId,storeId]
    )).rows,productsByArticle=new Map(products.map(row=>[row.wb_article,row]));
    const requestedIds=[...new Set(rows.map(row=>String(row?.expenseId??'').trim()).filter(Boolean))];
    const existingById=new Map();
    if(requestedIds.length){for(const row of(await client.query(`select id,product_id,current_version_id,external_entry_key from mc.expenses where business_id=$1 and store_id=$2 and id=any($3::uuid[])`,[businessId,storeId,requestedIds])).rows)existingById.set(row.id,row);}
    const prepared=[],errors=[],targets=new Map(),rowNumbers=new Set(),storageRowNumbers=new Set();
    for(let index=0;index<rows.length;index++){
      const source=rows[index]??{},rowNumber=Number(source.rowNumber),rowErrors=[];
      if(!Number.isInteger(rowNumber)||rowNumber<1||rowNumber>2147483647||rowNumbers.has(rowNumber))rowErrors.push(expenseRowError(Number.isInteger(rowNumber)?rowNumber:index+1,'expense_row_number_invalid'));else rowNumbers.add(rowNumber);
      let storageRowNumber=Number.isInteger(rowNumber)&&rowNumber>0&&rowNumber<=2147483647&&!storageRowNumbers.has(rowNumber)?rowNumber:1;while(storageRowNumbers.has(storageRowNumber))storageRowNumber++;storageRowNumbers.add(storageRowNumber);
      const expenseId=String(source.expenseId??'').trim(),wbArticle=String(source.wbArticle??'').trim(),product=wbArticle?productsByArticle.get(wbArticle):null;
      if(expenseId&&!uuidPattern.test(expenseId))rowErrors.push(expenseRowError(rowNumber,'expense_id_invalid'));
      if(wbArticle&&!/^\d+$/.test(wbArticle))rowErrors.push(expenseRowError(rowNumber,'expense_article_invalid'));
      if(wbArticle&&!product)rowErrors.push(expenseRowError(rowNumber,'expense_product_not_found',{wbArticle}));
      const existing=expenseId?existingById.get(expenseId):null;
      if(expenseId&&!existing)rowErrors.push(expenseRowError(rowNumber,'expense_not_found',{expenseId}));
      if(existing&&(existing.product_id??null)!==(product?.id??null))rowErrors.push(expenseRowError(rowNumber,'expense_scope_immutable',{expenseId}));
      let value=null;
      try{value=validateExpenseInput({...source,productId:product?.id??null});}catch(error){rowErrors.push(expenseRowError(rowNumber,error.message));}
      const externalKey=expenseId?existing?.external_entry_key:`file:${cleanChecksum}:${rowNumber}`,target=expenseId?`id:${expenseId}`:`key:${externalKey}`;
      let duplicate=false;
      if(value&&targets.has(target)){const prior=targets.get(target);if(prior.comparable!==expenseComparable(value))rowErrors.push(expenseRowError(rowNumber,'expense_duplicate_conflict',{previousRowNumber:prior.rowNumber}));else duplicate=true;}
      else if(value)targets.set(target,{rowNumber,comparable:expenseComparable(value)});
      prepared.push({source,rowNumber,storageRowNumber,rowErrors,expenseId,existing,externalKey,value,duplicate});errors.push(...rowErrors);
    }
    if(errors.length){
      for(const row of prepared)await client.query(
        `insert into mc.import_rows(business_id,store_id,batch_id,row_number,raw_values,status,errors) values($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb)`,
        [businessId,storeId,batch.id,row.storageRowNumber,JSON.stringify(row.source.rawValues??row.source),row.rowErrors.length?'invalid':row.duplicate?'duplicate':'valid',JSON.stringify(row.rowErrors)]
      );
      await client.query(`update mc.import_batches set status='failed' where id=$1`,[batch.id]);await client.query(`update mc.source_documents set completeness='partial' where id=$1`,[document.id]);
      return{ok:false,batchId:batch.id,documentId:document.id,applied:0,skipped:0,total:rows.length,errors};
    }
    await client.query(`update mc.import_batches set status='applying' where id=$1`,[batch.id]);let applied=0,skipped=0;
    for(const row of prepared){
      const rawValues=JSON.stringify(row.source.rawValues??row.source);
      if(row.duplicate){await client.query(`insert into mc.import_rows(business_id,store_id,batch_id,row_number,raw_values,status) values($1,$2,$3,$4,$5::jsonb,'duplicate')`,[businessId,storeId,batch.id,row.storageRowNumber,rawValues]);skipped++;continue;}
      let expense=row.existing;
      if(!expense){expense=(await client.query(
        `insert into mc.expenses(business_id,store_id,product_id,external_entry_key) values($1,$2,$3,$4)
         on conflict(store_id,external_entry_key) do nothing returning id,product_id,current_version_id,external_entry_key`,[businessId,storeId,row.value.productId,row.externalKey]
      )).rows[0];if(!expense)expense=(await client.query(`select id,product_id,current_version_id,external_entry_key from mc.expenses where business_id=$1 and store_id=$2 and external_entry_key=$3 for update`,[businessId,storeId,row.externalKey])).rows[0];}
      else expense=(await client.query(`select id,product_id,current_version_id,external_entry_key from mc.expenses where id=$1 for update`,[expense.id])).rows[0];
      const current=expense.current_version_id?(await client.query(`select category,amount::text,period_start::text,period_end::text,channel_name,description,recognition_method,state from mc.expense_versions where id=$1`,[expense.current_version_id])).rows[0]:null;
      if(current&&current.state==='active'&&expenseComparable({productId:expense.product_id,...current,amount:exactPositiveAmount(current.amount),periodStart:current.period_start,periodEnd:current.period_end,recognitionMethod:current.recognition_method,channelName:current.channel_name,description:current.description})===expenseComparable(row.value)){
        await client.query(`insert into mc.import_rows(business_id,store_id,batch_id,row_number,raw_values,status) values($1,$2,$3,$4,$5::jsonb,'skipped')`,[businessId,storeId,batch.id,row.storageRowNumber,rawValues]);skipped++;continue;
      }
      const importRow=(await client.query(`insert into mc.import_rows(business_id,store_id,batch_id,row_number,raw_values,status) values($1,$2,$3,$4,$5::jsonb,'applied') returning id`,[businessId,storeId,batch.id,row.storageRowNumber,rawValues])).rows[0];
      const versionNo=(await client.query(`select coalesce(max(version_no),0)+1 as n from mc.expense_versions where expense_id=$1`,[expense.id])).rows[0].n;
      const version=(await client.query(
        `insert into mc.expense_versions(business_id,store_id,expense_id,version_no,category,amount,period_start,period_end,channel_name,description,recognition_method,state,origin,import_row_id,changed_by)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active','file',$12,$13) returning id`,
        [businessId,storeId,expense.id,versionNo,row.value.category,row.value.amount,row.value.periodStart,row.value.periodEnd,row.value.channelName,row.value.description,row.value.recognitionMethod,importRow.id,userId]
      )).rows[0];await client.query(`update mc.expenses set current_version_id=$1 where id=$2`,[version.id,expense.id]);applied++;
    }
    await client.query(`update mc.import_batches set status='completed',applied_at=now() where id=$1`,[batch.id]);await client.query(`update mc.source_documents set completeness='complete' where id=$1`,[document.id]);
    return{ok:true,batchId:batch.id,documentId:document.id,applied,skipped,total:rows.length};
  });
}
