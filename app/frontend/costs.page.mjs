export function createCostPage({
  frame,
  esc,
  displayDate,
  dateValue
}) {
  function costPage(user, stores = user.stores, costs = null, {
    notice = '',
    error = '',
    importErrors = [],
    manualError = '',
    manualValues = null
  } = {}) {
    const importErrorMessages = {
      cost_row_number_invalid: 'некорректный номер строки',
      cost_invalid_article: 'некорректный артикул WB',
      cost_variant_missing: 'не указан ID варианта или штрихкод',
      cost_invalid_amount: 'некорректная себестоимость',
      cost_invalid_date: 'некорректная дата начала действия',
      cost_variant_mismatch: 'ID варианта и штрихкод относятся к разным вариантам',
      cost_variant_not_found: 'вариант не найден среди выбранных товаров',
      cost_duplicate_conflict: 'для одного варианта и даты указаны разные суммы'
    };
    const rowErrors = Array.isArray(importErrors) && importErrors.length ? `<div class="cost-row-errors" role="alert"><strong>Ошибки в таблице</strong><ul>${importErrors.slice(0,50).map(item=>`<li>Строка ${esc(item.rowNumber??'?')}: ${esc(importErrorMessages[item.code]??item.code??'неизвестная ошибка')}</li>`).join('')}</ul>${importErrors.length>50?`<p>Показаны первые 50 из ${importErrors.length} ошибок.</p>`:''}</div>`: '';
    const store = stores[0],
      feedback =(notice ? `<div class="settings-feedback success" role="status">${esc(notice)}</div>`: error ? `<div class="settings-feedback error" role="alert">${esc(error)}</div>`: '') + rowErrors;
    if (!store || !store.connected) return frame({
      ...user,
      stores
    }, '/costs', `<section class="costs-page"><a class="back-link" href="/settings#data">Вернуться в личный кабинет</a><h1>СЕБЕСТОИМОСТЬ ТОВАРОВ</h1>${feedback}<div class="settings-locked"><strong>${store?'Сначала подключите Wildberries':'Сначала добавьте магазин'}</strong><p class="muted">После подключения здесь появятся товары и их варианты.</p></div></section>`, stores);
    const nested = costs?.products ??[],
      variants = Array.isArray(costs?.rows) ? costs.rows.map(row =>({
      ...row,
      product: row
    })): nested.flatMap(product =>(product.variants ??[]).map(variant =>({
      ...variant,
      product
    }))),
      filled = Number(costs?.summary?.configuredVariants ?? variants.filter(variant => variant.unit_cost !== null && variant.unit_cost !== undefined).length),
      total = Number(costs?.summary?.totalVariants ?? variants.length),
      coverage = total ? Math.round(filled / total * 100): 0,
      last = costs?.lastImport;
    const lastImport = last ? `<div class="cost-import-status"><div><span>ПОСЛЕДНИЙ ИМПОРТ</span><strong>${esc(last.file_name)}</strong><small>${last.applied_rows??0} применено · ${last.skipped_rows??0} пропущено · ${last.invalid_rows??0} с ошибкой</small></div><time>${last.created_at?esc(new Date(last.created_at).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})):''}</time></div>`: '';
    const canEdit = costs?.canEdit ?? (!user.role || ['owner', 'editor'].includes(user.role)),
      today = new Intl.DateTimeFormat('en-CA', {timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date()),
      anchoredProducts = new Set();
    const rows = variants.map(variant => {
      const product = variant.product,
        wbUrl = `https://www.wildberries.ru/catalog/${encodeURIComponent(product.wb_article)}/detail.aspx`,
        labels = [variant.size_label, variant.color_label].filter(Boolean).join(' · ') || 'Основной вариант',
        effectiveFrom = displayDate(variant.effective_from),
        variantId = variant.variant_id ?? variant.id,
        productId = product.product_id ?? product.id,
        anchor = productId && !anchoredProducts.has(productId) ? ` id="cost-product-${esc(productId)}"` : '',
        retained = manualValues && String(manualValues.variantId) === String(variantId),
        unitCost = retained ? manualValues.unitCost : variant.unit_cost ?? '',
        inputDate = retained ? manualValues.effectiveFrom : dateValue(variant.effective_from) || today;
      if (productId) anchoredProducts.add(productId);
      const editor = canEdit && variantId ? `<details class="cost-editor"${retained ? ' open' : ''}><summary>${variant.unit_cost == null ? 'Указать себестоимость' : 'Изменить себестоимость'}</summary><form class="cost-edit-form" method="post" action="/costs/save"><input type="hidden" name="storeId" value="${esc(store.id)}"><input type="hidden" name="variantId" value="${esc(variantId)}"><label>Себестоимость, ₽<input name="unitCost" inputmode="decimal" maxlength="21" value="${esc(unitCost)}" required></label><label>Действует с<input type="date" name="effectiveFrom" value="${esc(inputDate)}" required></label>${retained && manualError ? `<p class="cost-edit-error" role="alert">${esc(manualError)}</p>` : ''}<button class="primary-button" type="submit">Сохранить</button></form></details>` : '';
      const productContent=`${!product.historical_deleted&&product.image_url?`<img src="${esc(product.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:''}<span><strong>${esc(product.title||product.seller_article||product.wb_article)}</strong><small>WB: ${esc(product.wb_article)} · ${esc(product.seller_article)}</small>${product.historical_deleted?'<small class="muted">Удалённый товар · добавлен из финансовых отчётов</small>':''}</span>`,
        productCard=product.historical_deleted?`<span class="cost-product">${productContent}</span>`:`<a class="cost-product" href="${wbUrl}" target="_blank" rel="noopener noreferrer">${productContent}</a>`;
      return `<tr${anchor}><td>${productCard}</td><td><strong>${esc(labels)}</strong><small>${variant.barcode?`Баркод: ${esc(variant.barcode)}`:`ID: ${esc(variant.external_variant_id??variantId)}`}</small></td><td>${variant.unit_cost!==null&&variant.unit_cost!==undefined?`<strong>${Number(variant.unit_cost).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})} ₽</strong><small>${effectiveFrom?`с ${esc(effectiveFrom)}`:''}</small>`:'<span class="cost-missing">Не указана</span>'}${editor}</td></tr>`
    }).join('');
    const manualFeedback = manualError && (!canEdit || !manualValues || !variants.some(variant => String(variant.variant_id ?? variant.id) === String(manualValues.variantId))) ? `<div class="settings-feedback error" role="alert">${esc(manualError)}</div>` : '';
    const table = manualFeedback + (rows ? `<div class="cost-table-wrap"><table class="cost-table"><thead><tr><th>Товар</th><th>Вариант</th><th>Себестоимость за единицу</th></tr></thead><tbody>${rows}</tbody></table></div>`: '<div class="products-empty">В каталоге пока нет вариантов товаров. Обновите каталог на странице товаров.</div>');
    return frame({
      ...user,
      stores
    }, '/costs', `<section class="costs-page"><a class="back-link" href="/settings#data">Вернуться в личный кабинет</a><div class="costs-title"><div><p class="eyebrow">Данные для расчёта прибыли</p><h1>СЕБЕСТОИМОСТЬ ТОВАРОВ</h1><p>Укажите себестоимость отдельного варианта или загрузите таблицу сразу для нескольких товаров.</p></div><a class="outline-button" href="/costs/template.csv?storeId=${encodeURIComponent(store.id)}">Скачать шаблон</a></div>${feedback}<div class="cost-summary"><div><span>ПОКРЫТИЕ</span><strong>${coverage}%</strong><small>${filled} из ${total} вариантов</small></div><div class="cost-progress" aria-label="Себестоимость указана для ${coverage}% вариантов"><i style="--coverage:${coverage}%"></i></div></div><section class="cost-import"><div><h2>ЗАГРУЗИТЬ СЕБЕСТОИМОСТЬ ИЗ ФАЙЛА</h2><p class="muted">Поддерживаются CSV, TSV и Excel (.xlsx). Старый XLS сначала сохраните как XLSX или CSV; SVG не является таблицей и не поддерживается.</p></div>${canEdit ? `<form method="post" action="/costs/import" enctype="multipart/form-data"><input type="hidden" name="storeId" value="${esc(store.id)}"><label class="cost-file">Выберите таблицу<input type="file" name="file" accept=".csv,.tsv,.xlsx,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required></label><button class="primary-button" type="submit">Загрузить и проверить</button></form>` : '<p class="muted">Изменять себестоимость могут владелец и редактор.</p>'}${lastImport}</section><section class="cost-list"><div class="cost-list-heading"><div><h2>ТОВАРЫ И ВАРИАНТЫ</h2><p class="muted">Сумма применяется с указанной даты. Чтобы задать новую стоимость на будущее, измените дату. Можно указать дату для прошлых продаж; история изменений сохраняется.</p></div><a href="/products">Управлять товарами →</a></div>${table}</section></section>`, stores);
  }
  return costPage;
}
