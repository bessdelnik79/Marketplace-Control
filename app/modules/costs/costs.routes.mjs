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
  costPage,
  send,
  sendBuffer,
  redirect,
  sameOrigin,
  takeLimit,
  multipart
}) {
  async function sendCosts(res, status, current, stores, options = {}) {
    const store = stores[0],
      costs = store ? await getCostState(current.user_id, store.id): null;
    return send(res, status, costPage(current, stores, costs, options));
  }
  async function dispatch(req, res, url, current) {
    if (req.method === 'GET' && url.pathname === '/costs/template.csv') {
      if (!current) return redirect(res, '/login');
      const stores = await listStores(current.user_id),
        store = stores.find(item => item.id ===(url.searchParams.get('storeId') || stores[0]?.id));
      if (!store) return send(res, 404, 'Магазин не найден.');
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
      const notice = url.searchParams.get('imported') === '1' ? 'Себестоимость из файла сохранена.': '';
      return sendCosts(res, 200, current, stores, {
        notice
      });
    }
    if (req.method === 'POST' && url.pathname === '/costs/import') {
      if (!current) return redirect(res, '/login');
      if (!sameOrigin(req)) return send(res, 403, 'Запрос отклонён.');
      const stores = await listStores(current.user_id),
        limit = await takeLimit(`cost-import:${current.user_id}`, 10, 15);
      if (!limit.allowed) return sendCosts(res, 429, current, stores, {
        error: 'Слишком много загрузок. Повторите через 15 минут.'
      });
      try {
        const upload = await multipart(req, costImportMaxBytes + 65536),
          store = stores.find(item => item.id === upload.fields.storeId),
          file = upload.files.file;
        if (!store) throw new Error('store_not_found');
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
          error: 'Файл не применён. Исправьте отмеченные строки и загрузите его снова.',
          importErrors: result.errors
        });
        return redirect(res, '/costs?imported=1');
      } catch (error) {
        if (error.message === 'cost_write_forbidden') return sendCosts(res, 403, current, stores, {
          error: 'Недостаточно прав для изменения себестоимости.'
        });
        if (error.message === 'store_not_found') return sendCosts(res, 404, current, stores, {
          error: 'Магазин не найден.'
        });
        return sendCosts(res, error.message === 'too_large' || error.message === 'cost_file_too_large' ? 413: 422, current, stores, {
          error: costImportMessage(error)
        });
      }
    }
  }
  return async function handleCosts(req, res, url, current) {
    const matches =(req.method === 'GET' &&['/costs', '/costs/template.csv'].includes(url.pathname)) ||(req.method === 'POST' && url.pathname === '/costs/import');
    if (!matches) return false;
    await dispatch(req, res, url, current);
    return true;
  };
}
