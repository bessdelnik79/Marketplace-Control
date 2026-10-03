export function createCostsRepository({
  withOwnedBusinessContext
}) {
  async function getCostState(userId, storeId) {
    return withOwnedBusinessContext(userId, async(client, businessId) => {
      const products =(await client.query(`select p.id,p.wb_article,p.seller_article,p.title,p.image_url,p.historical_deleted,
              v.id as variant_id,coalesce(v.wb_external_variant_id,v.external_variant_id) as external_variant_id,v.size_label,v.color_label,
              barcode.identifier_value as barcode,cv.id as cost_version_id,
              cv.unit_cost::text,c.effective_from
         from mc.product_selection_items i
         join mc.products p on (p.business_id,p.store_id,p.id)=(i.business_id,i.store_id,i.product_id)
         join mc.variants v on (v.business_id,v.store_id,v.product_id)=(p.business_id,p.store_id,p.id) and v.status='active'
         left join lateral (
           select identifier_value from mc.variant_identifiers vi
            where (vi.business_id,vi.store_id,vi.variant_id)=(v.business_id,v.store_id,v.id)
              and vi.identifier_type='barcode' and vi.valid_to is null
            order by vi.valid_from desc limit 1
         ) barcode on true
         left join lateral (
           select candidate.id,candidate.effective_from,candidate.current_version_id
             from mc.variant_costs candidate
            where (candidate.business_id,candidate.store_id,candidate.product_id,candidate.variant_id)=(v.business_id,v.store_id,v.product_id,v.id)
              and candidate.effective_from<=current_date
            order by candidate.effective_from desc limit 1
         ) c on true
         left join mc.cost_versions cv on (cv.business_id,cv.store_id,cv.cost_id,cv.id)=(v.business_id,v.store_id,c.id,c.current_version_id)
        where i.business_id=$1 and i.store_id=$2
        order by coalesce(p.title,p.seller_article),p.wb_article,v.size_label,v.external_variant_id`,[businessId, storeId])).rows;
      const grouped = [];
      const flatRows = [];
      for (const row of products) {
        let product = grouped.at(- 1);
        if (!product || product.id !== row.id) {
          product = {
            id: row.id,
            wb_article: String(row.wb_article),
            seller_article: row.seller_article,
            title: row.title,
            image_url: row.image_url,
            historical_deleted: row.historical_deleted,
            variants:[]
          };
          grouped.push(product);
        }
        const variant = {
          id: row.variant_id,
          external_variant_id: row.external_variant_id,
          size_label: row.size_label,
          color_label: row.color_label,
          barcode: row.barcode,
          unit_cost: row.unit_cost,
          effective_from: row.effective_from,
          cost_version_id: row.cost_version_id
        };
        product.variants.push(variant);
        flatRows.push({
          product_id: product.id,
          wb_article: product.wb_article,
          seller_article: product.seller_article,
          title: product.title,
          image_url: product.image_url,
          historical_deleted: product.historical_deleted,
          ...variant
        });
      }
      const lastImport =(await client.query(`select b.id,d.external_document_id as file_name,b.status,b.created_at,b.applied_at,
              count(r.id)::int as total_rows,
              count(*) filter(where r.status='applied')::int as applied_rows,
              count(*) filter(where r.status in ('skipped','duplicate'))::int as skipped_rows,
              count(*) filter(where r.status='invalid')::int as invalid_rows
         from mc.import_batches b
         join mc.source_documents d on (d.business_id,d.store_id,d.id)=(b.business_id,b.store_id,b.document_id)
         left join mc.import_rows r on (r.business_id,r.store_id,r.batch_id)=(b.business_id,b.store_id,b.id)
        where b.business_id=$1 and b.store_id=$2 and b.kind='costs'
        group by b.id,d.external_document_id,b.status,b.created_at,b.applied_at
        order by b.created_at desc limit 1`,[businessId, storeId])).rows[0] ?? null;
      return {
        products: grouped,
        rows: flatRows,
        summary: {
          totalVariants: flatRows.length,
          configuredVariants: flatRows.filter(row => row.unit_cost != null).length
        },
        lastImport
      };
    });
  }
  const costError =(rowNumber, code, details = {}) =>({
    rowNumber,
    code,
    ...(Object.keys(details).length ? {
      details
    }
    : {})
  });
  const costAmount = value => {
    const text = String(value ?? '').trim();
    if (!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/.test(text)) return null;
    const[whole, fraction = ''] = text.split('.');
    return `${whole}.${fraction.padEnd(4,'0')}`;
  };
  const costDate = value => {
    const text = String(value ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const parsed = new Date(`${text}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text: null;
  };
  async function importVariantCosts(userId, {
    storeId,
    fileName,
    checksum,
    rows
  }) {
    const cleanName = String(fileName ?? '').trim().slice(0, 255);
    const cleanChecksum = String(checksum ?? '').trim().toLowerCase();
    if (!storeId || !cleanName || !Array.isArray(rows) || !rows.length || rows.length > 10000 || !/^[a-f0-9]{64}$/.test(cleanChecksum)) throw new Error('cost_import_invalid');
    return withOwnedBusinessContext(userId, async(client, businessId, role) => {
      if (!['owner', 'editor'].includes(role)) throw new Error('cost_write_forbidden');
      const store =(await client.query(`select id from mc.stores where business_id=$1 and id=$2 and status='active'`,[businessId, storeId])).rows[0];
      if (!store) throw new Error('store_not_found');
      const document =(await client.query(`insert into mc.source_documents(business_id,store_id,origin,document_type,external_document_id,checksum,completeness)
       values($1,$2,'user_file','variant_costs',$3,$4,'unknown') returning id`,[businessId, storeId, cleanName, cleanChecksum])).rows[0];
      const batch =(await client.query(`insert into mc.import_batches(business_id,store_id,document_id,kind,uploaded_by,status,column_mapping)
       values($1,$2,$3,'costs',$4,'validating',$5::jsonb) returning id`,[businessId, storeId, document.id, userId, JSON.stringify({
        fileName: cleanName,
        checksum: cleanChecksum
      })])).rows[0];
      const variants =(await client.query(`select p.id as product_id,p.wb_article::text,v.id as variant_id,coalesce(v.wb_external_variant_id,v.external_variant_id) as external_variant_id,
              array_remove(array_agg(vi.identifier_value),null) as barcodes
         from mc.product_selection_items i
         join mc.products p on (p.business_id,p.store_id,p.id)=(i.business_id,i.store_id,i.product_id)
         join mc.variants v on (v.business_id,v.store_id,v.product_id)=(p.business_id,p.store_id,p.id) and v.status='active'
         left join mc.variant_identifiers vi on (vi.business_id,vi.store_id,vi.variant_id)=(v.business_id,v.store_id,v.id)
           and vi.identifier_type='barcode' and vi.valid_to is null
        where i.business_id=$1 and i.store_id=$2
        group by p.id,p.wb_article,v.id,v.external_variant_id`,[businessId, storeId])).rows;
      const byExternal = new Map(),
        byBarcode = new Map();
      for (const variant of variants) {
        byExternal.set(`${variant.wb_article}\0${variant.external_variant_id}`, variant);
        for (const barcode of variant.barcodes) byBarcode.set(`${variant.wb_article}\0${barcode}`, variant);
      }
      const prepared = [],
        errors = [],
        rowNumbers = new Set(),
        storageRowNumbers = new Set(),
        targets = new Map();
      for (let index = 0; index < rows.length; index++) {
        const source = rows[index] ?? {},
          rowNumber = Number(source.rowNumber),
          rowErrors = [];
        if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > 2147483647 || rowNumbers.has(rowNumber)) rowErrors.push(costError(Number.isInteger(rowNumber) ? rowNumber: index + 1, 'cost_row_number_invalid'));
        else rowNumbers.add(rowNumber);
        let storageRowNumber = Number.isInteger(rowNumber) && rowNumber > 0 && rowNumber <= 2147483647 && !storageRowNumbers.has(rowNumber) ? rowNumber: 1;
        while (storageRowNumbers.has(storageRowNumber)) storageRowNumber++;
        storageRowNumbers.add(storageRowNumber);
        const wbArticle = String(source.wbArticle ?? '').trim(),
          externalVariantId = String(source.externalVariantId ?? '').trim(),
          barcode = String(source.barcode ?? '').trim();
        const unitCost = costAmount(source.unitCost),
          effectiveFrom = costDate(source.effectiveFrom);
        if (!/^\d+$/.test(wbArticle) || wbArticle === '0') rowErrors.push(costError(rowNumber, 'cost_invalid_article'));
        if (!externalVariantId && !barcode) rowErrors.push(costError(rowNumber, 'cost_variant_missing'));
        if (!unitCost) rowErrors.push(costError(rowNumber, 'cost_invalid_amount'));
        if (!effectiveFrom) rowErrors.push(costError(rowNumber, 'cost_invalid_date'));
        const external = externalVariantId ? byExternal.get(`${wbArticle}\0${externalVariantId}`): null;
        const barcodeVariant = barcode ? byBarcode.get(`${wbArticle}\0${barcode}`): null;
        let variant = external ?? barcodeVariant ?? null;
        if (external && barcodeVariant && external.variant_id !== barcodeVariant.variant_id) {
          variant = null;
          rowErrors.push(costError(rowNumber, 'cost_variant_mismatch'));
        } else if (((externalVariantId && !external) ||(barcode && !barcodeVariant) || !variant) && !rowErrors.some(error => ['cost_invalid_article', 'cost_variant_missing'].includes(error.code))) {
          variant = null;
          rowErrors.push(costError(rowNumber, 'cost_variant_not_found', {
            wbArticle,
            externalVariantId,
            barcode
          }));
        }
        const target = variant && effectiveFrom ? `${variant.variant_id}\0${effectiveFrom}`: null;
        let duplicate = false;
        if (target && targets.has(target)) {
          const prior = targets.get(target);
          if (prior.unitCost !== unitCost) rowErrors.push(costError(rowNumber, 'cost_duplicate_conflict', {
            previousRowNumber: prior.rowNumber
          }));
          else duplicate = true;
        } else {
          if (target) targets.set(target, {
            rowNumber,
            unitCost
          });
        }
        prepared.push({
          duplicate,
          storageRowNumber,
          rowNumber,
          source,
          variant,
          wbArticle,
          externalVariantId,
          barcode,
          unitCost,
          effectiveFrom,
          target,
          rowErrors
        });
        errors.push(...rowErrors);
      }
      if (errors.length) {
        for (const row of prepared) await client.query(`insert into mc.import_rows(business_id,store_id,batch_id,row_number,raw_values,status,errors)
         values($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb)`,[businessId, storeId, batch.id, row.storageRowNumber, JSON.stringify(row.source.rawValues ?? {
          wbArticle: row.wbArticle,
          externalVariantId: row.externalVariantId,
          barcode: row.barcode,
          unitCost: row.unitCost,
          effectiveFrom: row.effectiveFrom
        }), row.rowErrors.length ? 'invalid': row.duplicate ? 'duplicate': 'valid', JSON.stringify(row.rowErrors)]);
        await client.query(`update mc.import_batches set status='failed' where id=$1`,[batch.id]);
        await client.query(`update mc.source_documents set completeness='partial' where id=$1`,[document.id]);
        return {
          ok: false,
          batchId: batch.id,
          documentId: document.id,
          applied: 0,
          skipped: 0,
          total: rows.length,
          errors
        };
      }
      await client.query(`update mc.import_batches set status='applying' where id=$1`,[batch.id]);
      let applied = 0,
        skipped = 0;
      for (const row of prepared) {
        const rawValues = JSON.stringify(row.source.rawValues ?? {
          wbArticle: row.wbArticle,
          externalVariantId: row.externalVariantId,
          barcode: row.barcode,
          unitCost: row.unitCost,
          effectiveFrom: row.effectiveFrom
        });
        if (row.duplicate) {
          await client.query(`insert into mc.import_rows(business_id,store_id,batch_id,row_number,raw_values,status) values($1,$2,$3,$4,$5::jsonb,'duplicate')`,[businessId, storeId, batch.id, row.storageRowNumber, rawValues]);
          skipped++;
          continue;
        }
        let cost =(await client.query(`insert into mc.variant_costs(business_id,store_id,product_id,variant_id,effective_from)
         values($1,$2,$3,$4,$5) on conflict(variant_id,effective_from) do nothing returning id,current_version_id`,[businessId, storeId, row.variant.product_id, row.variant.variant_id, row.effectiveFrom])).rows[0];
        if (!cost) cost =(await client.query(`select id,current_version_id from mc.variant_costs where business_id=$1 and store_id=$2 and variant_id=$3 and effective_from=$4 for update`,[businessId, storeId, row.variant.variant_id, row.effectiveFrom])).rows[0];
        else cost =(await client.query(`select id,current_version_id from mc.variant_costs where id=$1 for update`,[cost.id])).rows[0];
        const current = cost.current_version_id ?(await client.query(`select unit_cost::text from mc.cost_versions where id=$1`,[cost.current_version_id])).rows[0]: null;
        if (current && costAmount(current.unit_cost) === row.unitCost) {
          await client.query(`insert into mc.import_rows(business_id,store_id,batch_id,row_number,raw_values,status) values($1,$2,$3,$4,$5::jsonb,'skipped')`,[businessId, storeId, batch.id, row.storageRowNumber, rawValues]);
          skipped++;
          continue;
        }
        const importRow =(await client.query(`insert into mc.import_rows(business_id,store_id,batch_id,row_number,raw_values,status)
         values($1,$2,$3,$4,$5::jsonb,'applied') returning id`,[businessId, storeId, batch.id, row.storageRowNumber, rawValues])).rows[0];
        const versionNo =(await client.query(`select coalesce(max(version_no),0)+1 as n from mc.cost_versions where cost_id=$1`,[cost.id])).rows[0].n;
        const version =(await client.query(`insert into mc.cost_versions(business_id,store_id,cost_id,version_no,unit_cost,origin,import_row_id,changed_by)
         values($1,$2,$3,$4,$5,'file',$6,$7) returning id`,[businessId, storeId, cost.id, versionNo, row.unitCost, importRow.id, userId])).rows[0];
        await client.query(`update mc.variant_costs set current_version_id=$1 where id=$2`,[version.id, cost.id]);
        applied++;
      }
      await client.query(`update mc.import_batches set status='completed',applied_at=now() where id=$1`,[batch.id]);
      await client.query(`update mc.source_documents set completeness='complete' where id=$1`,[document.id]);
      return {
        ok: true,
        batchId: batch.id,
        documentId: document.id,
        applied,
        skipped,
        total: rows.length
      };
    });
  }
  return {
    getCostState,
    importVariantCosts
  };
}
