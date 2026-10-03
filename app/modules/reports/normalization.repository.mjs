import { financialComponentScope, financialParserVersion, isResolvedNonProductOperation, normalizeFinancialOperation, unverifiedFinancialComponents } from './finance.mjs';
import { recoverHistoricalCatalog } from '../catalog/historical-catalog.repository.mjs';
import { pool,withBusinessContext } from '../../infrastructure/database/client.mjs';

export async function persistFinancialNormalization(client,{businessId,storeId,reportVersionId:versionId,catalogRevision}){
  const source=(await client.query(`select rv.document_id,rv.parser_version,r.external_report_id,r.period_start::text,r.period_end::text from mc.report_versions rv join mc.reports r on r.id=rv.report_id where rv.business_id=$1 and rv.store_id=$2 and rv.id=$3`,[businessId,storeId,versionId])).rows[0];
  if(!source)throw new Error('financial_report_version_missing');
  if(source.parser_version!==financialParserVersion)throw new Error('financial_exact_source_required');
  const method=(await client.query(`select id from mc.method_versions where code='wb_finance_import' and implementation_version=$1 order by version_no desc limit 1`,[financialParserVersion])).rows[0];
  if(!method)throw new Error('financial_method_missing');
  let normalization=(await client.query(
    `select id from mc.report_normalizations where report_version_id=$1 and method_version_id=$2 and catalog_revision=$3 and status='succeeded'`,
    [versionId,method.id,catalogRevision])).rows[0];
  let insertedRows=0,issues=0;
  if(!normalization){
    normalization=(await client.query(
      `insert into mc.report_normalizations(business_id,store_id,report_version_id,method_version_id,normalization_key,status,catalog_revision)
       values($1,$2,$3,$4,$5,'succeeded',$6) returning id`,
      [businessId,storeId,versionId,method.id,`${financialParserVersion}:${versionId}:catalog:${catalogRevision}`,catalogRevision])).rows[0];
    const rows=(await client.query(
      `select id,external_row_key,raw_data,row_checksum from mc.report_rows where report_version_id=$1 order by row_number,id`,[versionId])).rows;
    for(const row of rows){
      const normalized=normalizeFinancialOperation(row.raw_data);
      if(normalized.accountingDate<source.period_start||normalized.accountingDate>source.period_end)throw new Error('financial_row_period_mismatch');
      let product=null,variant=null;
      if(normalized.wbArticle&&/^\d+$/.test(normalized.wbArticle))product=(await client.query(
        `select id from mc.products where business_id=$1 and store_id=$2 and wb_article=$3::bigint`,
        [businessId,storeId,normalized.wbArticle])).rows[0]??null;
      if(product&&normalized.variantBarcode)variant=(await client.query(
        `select v.id from mc.variants v join mc.variant_identifiers i on i.business_id=v.business_id and i.store_id=v.store_id and i.variant_id=v.id
          where v.business_id=$1 and v.store_id=$2 and v.product_id=$3 and i.identifier_type='barcode' and i.identifier_value=$4 and i.valid_to is null limit 1`,
        [businessId,storeId,product.id,normalized.variantBarcode])).rows[0]??null;
      const addIssue=async(code,severity,details)=>{issues++;await client.query(
        `insert into mc.data_issues(business_id,store_id,document_id,report_row_id,report_normalization_id,code,severity,details)
         values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [businessId,storeId,source.document_id,row.id,normalization.id,code,severity,JSON.stringify(details)]);};
      const sizeLabel=String(row.raw_data.techSize??'').trim();
      if(product&&!variant&&sizeLabel&&['sale','return'].includes(normalized.operationType)){
        const sizeVariants=(await client.query(
          `select id from mc.variants where business_id=$1 and store_id=$2 and product_id=$3 and status='active' and btrim(size_label)=$4 limit 2`,
          [businessId,storeId,product.id,sizeLabel])).rows;
        if(sizeVariants.length===1){
          variant=sizeVariants[0];
          await addIssue('financial_variant_matched_by_size','warning',{wbArticle:normalized.wbArticle,sourceBarcode:normalized.variantBarcode,sizeLabel,variantId:variant.id});
        }
      }
      if(normalized.wbArticle&&!product)await addIssue('financial_product_not_in_catalog','warning',{wbArticle:normalized.wbArticle});
      if(product&&normalized.variantBarcode&&!variant)await addIssue('financial_variant_not_matched','warning',{wbArticle:normalized.wbArticle});
      const unverified=unverifiedFinancialComponents(row.raw_data,normalized,Boolean(product));
      if(normalized.operationType==='unclassified'&&!isResolvedNonProductOperation(row.raw_data,normalized,Boolean(product)))await addIssue('financial_operation_unclassified','blocking',{docTypeName:String(row.raw_data.docTypeName??''),sellerOperName:String(row.raw_data.sellerOperName??'')});
      if(unverified.length)await addIssue('financial_components_unverified','blocking',{sourceFields:unverified});
      const sourceKey=`${source.external_report_id}/${row.external_row_key}`;
      let operation=(await client.query(`select id from mc.operations where store_id=$1 and source_code='wb_finance' and source_operation_key=$2`,[storeId,sourceKey])).rows[0];
      if(!operation)operation=(await client.query(
        `insert into mc.operations(business_id,store_id,source_code,source_operation_key) values($1,$2,'wb_finance',$3) returning id`,
        [businessId,storeId,sourceKey])).rows[0];
      const no=(await client.query('select coalesce(max(version_no),0)+1 as n from mc.operation_versions where operation_id=$1',[operation.id])).rows[0].n;
      const operationVersion=(await client.query(
        `insert into mc.operation_versions(business_id,store_id,operation_id,report_row_id,version_no,srid,operation_type,product_id,variant_id,accounting_date,source_occurred_at,quantity,currency,report_normalization_id)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'RUB',$13) returning id`,
        [businessId,storeId,operation.id,row.id,no,normalized.srid,normalized.operationType,product?.id??null,variant?.id??null,normalized.accountingDate,normalized.sourceOccurredAt,normalized.quantity,normalization.id])).rows[0];
      for(const component of normalized.components)await client.query(
        `insert into mc.financial_components(business_id,store_id,operation_version_id,component_key,category_code,amount_signed,method_version_id,source_field,result_scope_classification)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [businessId,storeId,operationVersion.id,component.componentKey,component.categoryCode,component.amountSigned,method.id,component.sourceField,financialComponentScope(row.raw_data,normalized,component,Boolean(product))]);
      insertedRows++;
    }
  }

  await client.query(`update mc.data_issues old_issue set status='resolved',resolved_at=clock_timestamp(),resolved_by_normalization_id=$1 from mc.report_rows rr where old_issue.business_id=$2 and old_issue.store_id=$3 and old_issue.report_row_id=rr.id and rr.report_version_id=$4 and old_issue.status='open' and old_issue.report_normalization_id is distinct from $1 and not exists(select 1 from mc.data_issues current_issue where current_issue.report_normalization_id=$1 and current_issue.report_row_id=old_issue.report_row_id and current_issue.code=old_issue.code and current_issue.status='open')`,[normalization.id,businessId,storeId,versionId]);
  return {id:normalization.id,insertedRows,issues,cached:insertedRows===0};
}

export async function reconcileHistoricalCatalogLinks(client,{businessId,storeId}){
  const recovery=await recoverHistoricalCatalog(client,{businessId,storeId});
  const reports=(await client.query(`select rv.id,r.period_start::text,r.period_end::text from mc.reports r join mc.report_versions rv on rv.id=r.current_version_id where r.business_id=$1 and r.store_id=$2 and rv.status='accepted' and rv.parser_version=$4 and not exists(select 1 from mc.report_normalizations n join mc.method_versions m on m.id=n.method_version_id where n.report_version_id=rv.id and n.status='succeeded' and n.catalog_revision=$3 and m.implementation_version=$4) order by r.period_start,r.external_report_id`,[businessId,storeId,recovery.catalogRevision,financialParserVersion])).rows;
  for(const report of reports){
    const normalization=await persistFinancialNormalization(client,{businessId,storeId,reportVersionId:report.id,catalogRevision:recovery.catalogRevision});
    await client.query(`update mc.financial_week_inventory set accepted_normalization_id=$2 where business_id=$3 and store_id=$4 and report_version_id=$1 and fetch_status='accepted'`,[report.id,normalization.id,businessId,storeId]);
    await client.query(`select id from mc.emit_financial_input_event($1,$2,'report_updated',$3,$4,p_source_report_version_id=>$5,p_source_normalization_id=>$6)`,[storeId,`historical-catalog:${report.id}:${recovery.catalogRevision}`,report.period_start,report.period_end,report.id,normalization.id]);
  }
  return {...recovery,normalizedReports:reports.length};
}

export async function reconcileHistoricalCatalogs(){
  const targets=(await pool.query(`select requested_by as user_id,business_id,store_id from mc.operational_sync_targets order by store_id`)).rows;
  for(const target of targets){
    try{
      await withBusinessContext(target.user_id,target.business_id,async(client,businessId,role)=>{
        if(!['owner','editor'].includes(role))return null;
        const active=(await client.query(`select id from mc.stores where business_id=$1 and id=$2 and status='active'`,[businessId,target.store_id])).rows[0];
        return active?reconcileHistoricalCatalogLinks(client,{businessId,storeId:target.store_id}):null;
      });
    }catch(error){console.warn('[historical catalog store reconciliation failed]',error?.message??'unknown');}
  }
}
