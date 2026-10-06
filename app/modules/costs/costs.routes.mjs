import { createHash } from 'node:crypto';
import { costImportMaxBytes, createCostCsvTemplate, parseCostFile } from './costs.import.mjs';
const costImportErrors = {
  cost_file_empty: 'Файл не содержит строк себестоимости.',
  cost_file_too_large: 'Файл больше 5 МБ.',
  cost_file_expanded_too_large: 'Распакованный Excel-файл слишком большой или содержит слишком много частей.',
  cost_file_type: 'Поддерживаются файлы CSV, TSV и XLSX.',
  cost_legacy_xls: 'Сохраните старый XLS как XLSX или CSV и загрузите снова.',
  cost_file_encoding: 'Сохраните CSV в кодировке UTF-8.',
  cost_file_invalid_csv: 'Не удалось прочитать CSV. Проверьте кавычки и разделители.',
  cost_file_invalid_excel: 'Не удалось прочитать Excel-файл.',
  cost_formula_cell: 'Замените формулы в таблице их вычисленными значениями.',
  cost_columns_missing: 'Не найдены обязательные столбцы: Артикул WB, Себестоимость и Действует с.',
  cost_variant_column_missing: 'Добавьте столбец ID варианта или Штрихкод.',
  cost_duplicate_columns: 'В файле повторяются служебные столбцы.',
  cost_too_many_columns: 'В файле больше 30 столбцов.',
  cost_identifier_format: 'Артикулы, ID вариантов и штрихкоды должны храниться в таблице как текст.',
  cost_invalid_article: 'Некорректный артикул WB.',
  cost_variant_missing: 'Не указан ID варианта или штрихкод.',
  cost_invalid_amount: 'Себестоимость должна быть неотрицательным числом, не более четырёх знаков после запятой.',
  cost_invalid_date: 'Дата должна быть в формате ДД.ММ.ГГГГ или ГГГГ-ММ-ДД.',
  cost_too_many_rows: 'Один файл может содержать не более 10 000 строк.',
  multipart_required: 'Выберите файл для загрузки.',
  multipart_invalid: 'Не удалось прочитать загруженный файл.',
  too_large: 'Файл больше 5 МБ.'
};
function costImportMessage(error) {
  const message = costImportErrors[error?.message] ?? 'Не удалось импортировать себестоимость.';
  return error?.rowNumber ? `Строка ${error.rowNumber}: ${message}`: message;
}
export function createCostsRoutes({
  listStores,
  getCostState,
  importVariantCosts,
  saveVariantCost,
  form,
  costPage,
  send,
  sendBuffer,
  redirect,
  sameOrigin,
  takeLimit,
  multipart
}) {
  async function sendCosts(res, status, current, stores, options = {}) {
    const store = stores.find(item => item.selectable!==false && item.id === (options.storeId || stores[0]?.id)),
      costs = store ? await getCostState(current.user_id, store.id): null;
    const orderedStores = store ? [store, ...stores.filter(item => item.id !== store.id)]: stores;
    return send(res, status, costPage(current, orderedStores, costs, options));
  }
  async function dispatch(req, res, url, current) {
    if (req.method === 'GET' && url.pathname === '/costs/template.csv') {
      if (!current) return redirect(res, '/login');
      const stores = await listStores(current.user_id),
        store = stores.find(item => item.selectable!==false && item.id ===(url.searchParams.get('storeId') || stores[0]?.id));
      if (!store || store.selectable===false) return send(res, 404, 'Магазин не найден.');
      const costs = await getCostState(current.user_id, store.id),
        template = createCostCsvTemplate(costs?.rows ??[]);
      return sendBuffer(res, 200, template, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="costs-${new Date().toISOString().slice(0,10)}.csv"`
      });
    }
    if (req.method === 'GET' && url.pathname === '/costs') {
      if (!current) return redirect(res, '/login');
      const stores = await listStores(current.user_id);
      const storeId = url.searchParams.get('storeId');
      if (storeId && !stores.some(store => store.selectable!==false && store.id === storeId)) return send(res, 404, 'Магазин не найден.');
      const notice = url.searchParams.get('imported') === '1' ? 'Себестоимость из файла сохранена.': url.searchParams.get('saved') === '1' ? 'Себестоимость сохранена.': url.searchParams.get('skipped') === '1' ? 'Такая себестоимость уже сохранена.': '';
      return sendCosts(res, 200, current, stores, {
        notice, storeId
      });
    }
    if (req.method === 'POST' && url.pathname === '/costs/save') {
      if (!current) return redirect(res, '/login');
      if (!sameOrigin(req)) return send(res, 403, 'Запрос отклонён.');
      const stores = await listStores(current.user_id);
      let values = {};
      try {
        const limit = await takeLimit(`cost-save:${current.user_id}`, 60, 15);
        if (!limit.allowed) return sendCosts(res, 429, current, stores, { error: 'Слишком много сохранений. Повторите через 15 минут.' });
        const data = await form(req);
        values = Object.fromEntries(['storeId','variantId','unitCost','effectiveFrom'].map(key => [key, typeof data[key] === 'string' ? data[key]: '']));
        const store = stores.find(item => item.selectable!==false && item.id === values.storeId);
        if (!store || store.selectable===false) throw new Error('store_not_found');
        const result = await saveVariantCost(current.user_id, values);
        return redirect(res, `/costs?${result.skipped ? 'skipped': 'saved'}=1&storeId=${encodeURIComponent(store.id)}`);
      } catch (error) {
        const messages = {
          cost_invalid_amount: costImportErrors.cost_invalid_amount,
          cost_invalid_date: 'Укажите существующую дату в формате ГГГГ-ММ-ДД.',
          cost_variant_not_found: 'Выбранная вариация товара не найдена.',
          cost_write_forbidden: 'Недостаточно прав для изменения себестоимости.',
          store_not_found: 'Магазин не найден.',
          too_large: 'Форма слишком большая.'
        };
        if (!messages[error.message]) throw error;
        const status = error.message === 'cost_write_forbidden' ? 403: ['store_not_found','cost_variant_not_found'].includes(error.message) ? 404: error.message === 'too_large' ? 413: 422;
        return sendCosts(res, status, current, stores, {
          storeId: stores.some(store => store.id === values.storeId) ? values.storeId: undefined,
          manualError: messages[error.message], manualValues: values
        });
      }
    }
    if (req.method === 'POST' && url.pathname === '/costs/import') {
      if (!current) return redirect(res, '/login');
      if (!sameOrigin(req)) return send(res, 403, 'Запрос отклонён.');
      const stores = await listStores(current.user_id),
        limit = await takeLimit(`cost-import:${current.user_id}`, 10, 15);
      if (!limit.allowed) return sendCosts(res, 429, current, stores, {
        error: 'Слишком много загрузок. Повторите через 15 минут.'
      });
      let storeId;
      try {
        const upload = await multipart(req, costImportMaxBytes + 65536),
          store = stores.find(item => item.selectable!==false && item.id === upload.fields.storeId),
          file = upload.files.file;
        if (!store || store.selectable===false) throw new Error('store_not_found');
        storeId = store.id;
        if (!file?.fileName || !file.buffer?.length) throw new Error('cost_file_empty');
        const rows = await parseCostFile(file),
          checksum = createHash('sha256').update(file.buffer).digest('hex');
        const result = await importVariantCosts(current.user_id, {
          storeId: store.id,
          fileName: file.fileName,
          checksum,
          rows
        });
        if (!result.ok) return sendCosts(res, 422, current, stores, {
          storeId,
          error: 'Файл не применён. Исправьте отмеченные строки и загрузите его снова.',
          importErrors: result.errors
        });
        return redirect(res, `/costs?storeId=${encodeURIComponent(store.id)}&imported=1`);
      } catch (error) {
        if (error.message === 'cost_write_forbidden') return sendCosts(res, 403, current, stores, {
          storeId,
          error: 'Недостаточно прав для изменения себестоимости.'
        });
        if (error.message === 'store_not_found') return sendCosts(res, 404, current, stores, {
          error: 'Магазин не найден.'
        });
        return sendCosts(res, error.message === 'too_large' || error.message === 'cost_file_too_large' ? 413: 422, current, stores, {
          storeId,
          error: costImportMessage(error)
        });
      }
    }
  }
  return async function handleCosts(req, res, url, current) {
    const matches =(req.method === 'GET' &&['/costs', '/costs/template.csv'].includes(url.pathname)) ||(req.method === 'POST' && ['/costs/import','/costs/save'].includes(url.pathname));
    if (!matches) return false;
    await dispatch(req, res, url, current);
    return true;
  };
}
