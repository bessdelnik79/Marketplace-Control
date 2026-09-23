import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createExpenseCsvExport, createExpenseCsvTemplate, expenseImportMaxBytes, parseExpenseFile } from './expense-import.mjs';

test('expense CSV accepts Russian headers, aliases, decimal comma and on-date default',async()=>{
  const csv='ID расхода;Артикул WB;Категория;Сумма, ₽;Начало периода;Метод признания;Канал;Описание\r\n550e8400-e29b-41d4-a716-446655440000;123456;Упаковка;1 234,50;20.09.2026;На дату;Ozon;Коробки\r\n';
  const [row]=await parseExpenseFile({fileName:'expenses.csv',buffer:Buffer.from(csv)});
  assert.deepEqual(row,{
    rowNumber:2,expenseId:'550e8400-e29b-41d4-a716-446655440000',wbArticle:'123456',category:'packaging',amount:'1234.5000',
    periodStart:'2026-09-20',periodEnd:'2026-09-20',recognitionMethod:'on_date',channelName:'Ozon',description:'Коробки',
    rawValues:{expenseId:'550e8400-e29b-41d4-a716-446655440000',wbArticle:'123456',category:'packaging',amount:'1234.5000',periodStart:'2026-09-20',periodEnd:'2026-09-20',recognitionMethod:'on_date',channelName:'Ozon',description:'Коробки'}
  });
});

test('expense TSV supports English headers and a business-wide period expense',async()=>{
  const tsv='expense_id\twb_article\tcategory\tamount\tperiod_start\tperiod_end\trecognition_method\tchannel_name\tdescription\n\t\texternal_promotion\t50.125\t2026-09-01\t2026-09-30\tevenly_over_period\tWB\tAds\n';
  const [row]=await parseExpenseFile({fileName:'expenses.tsv',buffer:Buffer.from(tsv)});
  assert.equal(row.expenseId,'');
  assert.equal(row.wbArticle,'');
  assert.equal(row.category,'external_promotion');
  assert.equal(row.amount,'50.1250');
  assert.equal(row.periodEnd,'2026-09-30');
});

test('expense XLSX preserves text identifiers, dates and rejects formula cells',async()=>{
  const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('Расходы');
  sheet.addRow(['ID расхода','Артикул WB','Категория','Сумма','Начало периода','Конец периода','Метод признания']);
  sheet.addRow(['550e8400-e29b-41d4-a716-446655440000','90071992547409931','agency_services',875.125,new Date('2026-09-01T00:00:00Z'),new Date('2026-09-30T00:00:00Z'),'evenly_over_period']);
  const [row]=await parseExpenseFile({fileName:'expenses.xlsx',buffer:Buffer.from(await workbook.xlsx.writeBuffer())});
  assert.equal(row.wbArticle,'90071992547409931');
  assert.equal(row.amount,'875.1250');
  assert.equal(row.periodStart,'2026-09-01');

  const formulas=new ExcelJS.Workbook(),formulaSheet=formulas.addWorksheet('Расходы');
  formulaSheet.addRow(['Категория','Сумма','Начало периода','Метод признания']);
  formulaSheet.addRow(['packaging',{formula:'5+5',result:10},'2026-09-20','on_date']);
  const formulaBuffer=Buffer.from(await formulas.xlsx.writeBuffer());
  await assert.rejects(()=>parseExpenseFile({fileName:'formula.xlsx',buffer:formulaBuffer}),/expense_formula_cell/);
});

test('expense import validates file type, size and required columns',async()=>{
  await assert.rejects(()=>parseExpenseFile({fileName:'expenses.xls',buffer:Buffer.from('legacy')}),/expense_legacy_xls/);
  await assert.rejects(()=>parseExpenseFile({fileName:'expenses.json',buffer:Buffer.from('{}')}),/expense_file_type/);
  await assert.rejects(()=>parseExpenseFile({fileName:'expenses.csv',buffer:Buffer.alloc(expenseImportMaxBytes+1,65)}),/expense_file_too_large/);
  await assert.rejects(()=>parseExpenseFile({fileName:'expenses.csv',buffer:Buffer.from([0xff,0xfe,0x00])}),/expense_file_encoding/);
  await assert.rejects(()=>parseExpenseFile({fileName:'expenses.csv',buffer:Buffer.from('Категория;Сумма\npackaging;10')}),/expense_columns_missing/);
  const tooManyColumns=Array.from({length:31},(_,index)=>index<4?['Категория','Сумма','Начало периода','Метод признания'][index]:`Лишний ${index}`).join(';');
  await assert.rejects(()=>parseExpenseFile({fileName:'expenses.csv',buffer:Buffer.from(`${tooManyColumns}\npackaging;10;2026-09-20;on_date`)}),/expense_too_many_columns/);
  const header='Категория;Сумма;Начало периода;Метод признания\n';
  const tooManyRows=header+'packaging;10;2026-09-20;on_date\n'.repeat(10001);
  await assert.rejects(()=>parseExpenseFile({fileName:'expenses.csv',buffer:Buffer.from(tooManyRows)}),/expense_too_many_rows/);
});

test('expense import rejects XLSX archives over expanded-size and entry-count limits',async()=>{
  const expandedArchive=Buffer.alloc(50);
  expandedArchive.writeUInt32LE(0x04034b50,0);
  expandedArchive.writeUInt32LE(0x02014b50,4);
  expandedArchive.writeUInt32LE(25*1024*1024+1,28);
  await assert.rejects(()=>parseExpenseFile({fileName:'expanded.xlsx',buffer:expandedArchive}),/expense_file_expanded_too_large/);

  const manyEntriesArchive=Buffer.alloc(4+201*46);
  manyEntriesArchive.writeUInt32LE(0x04034b50,0);
  for(let index=0;index<201;index++)manyEntriesArchive.writeUInt32LE(0x02014b50,4+index*46);
  await assert.rejects(()=>parseExpenseFile({fileName:'entries.xlsx',buffer:manyEntriesArchive}),/expense_file_expanded_too_large/);
});

test('expense import validates amount, category, method, dates, UUID and article with row number',async()=>{
  const header='ID расхода;Артикул WB;Категория;Сумма;Начало периода;Конец периода;Метод признания\n';
  const invalidRows=[
    [';123;packaging;0;2026-09-20;;on_date','expense_invalid_amount'],
    [';123;unknown;10;2026-09-20;;on_date','expense_invalid_category'],
    [';123;packaging;10;2026-09-20;;later','expense_invalid_recognition_method'],
    [';123;packaging;10;2026-02-30;;on_date','expense_invalid_date'],
    [';123;packaging;10;2026-09-20;2026-09-21;on_date','expense_on_date_period_mismatch'],
    [';123;packaging;10;2026-09-21;2026-09-20;evenly_over_period','expense_invalid_period'],
    ['not-a-uuid;123;packaging;10;2026-09-20;;on_date','expense_invalid_id'],
    [';sku-1;packaging;10;2026-09-20;;on_date','expense_invalid_article']
  ];
  for(const [source,message] of invalidRows){
    await assert.rejects(()=>parseExpenseFile({fileName:'expenses.csv',buffer:Buffer.from(header+source)}),error=>error.message===message&&error.rowNumber===2);
  }
});

test('evenly-over-period requires an end date and text fields have limits',async()=>{
  const header='Категория;Сумма;Начало периода;Конец периода;Метод признания;Канал;Описание\n';
  await assert.rejects(()=>parseExpenseFile({fileName:'expenses.csv',buffer:Buffer.from(`${header}packaging;10;2026-09-20;;evenly_over_period;;`)}),error=>error.message==='expense_period_end_missing'&&error.rowNumber===2);
  await assert.rejects(()=>parseExpenseFile({fileName:'expenses.csv',buffer:Buffer.from(`${header}packaging;10;2026-09-20;;on_date;${'x'.repeat(121)};`)}),/expense_invalid_channel_name/);
  await assert.rejects(()=>parseExpenseFile({fileName:'expenses.csv',buffer:Buffer.from(`${header}packaging;10;2026-09-20;;on_date;;${'x'.repeat(501)}`)}),/expense_invalid_description/);
});

test('expense export includes stable ID, escapes CSV and neutralizes spreadsheet formulas',async()=>{
  const buffer=createExpenseCsvExport([{
    expense_id:'550e8400-e29b-41d4-a716-446655440000',wb_article:'123',category:'software_services',amount:'10.5000',
    period_start:'2026-09-20',period_end:'2026-09-20',recognition_method:'on_date',channel_name:'\t+channel',description:'=HYPERLINK("bad"); next\nline'
  }]);
  const text=buffer.toString('utf8');
  assert.ok(text.startsWith('\uFEFFID расхода;'));
  assert.match(text,/;'\t\+channel;/);
  assert.match(text,/"'=HYPERLINK\(""bad""\); next\nline"/);
  const [row]=await parseExpenseFile({fileName:'export.csv',buffer});
  assert.equal(row.expenseId,'550e8400-e29b-41d4-a716-446655440000');
  assert.equal(row.channelName,"'\t+channel");
  assert.equal(row.description,"'=HYPERLINK(\"bad\"); next\nline");
});

test('expense export excludes voided records so re-import cannot reactivate them',async()=>{
  const buffer=createExpenseCsvExport([
    {expense_id:'550e8400-e29b-41d4-a716-446655440000',category:'packaging',amount:'10.0000',period_start:'2026-09-20',period_end:'2026-09-20',recognition_method:'on_date',state:'active'},
    {expense_id:'550e8400-e29b-41d4-a716-446655440001',category:'packaging',amount:'20.0000',period_start:'2026-09-20',period_end:'2026-09-20',recognition_method:'on_date',state:'voided'}
  ]);
  const rows=await parseExpenseFile({fileName:'export.csv',buffer});
  assert.deepEqual(rows.map(row=>row.expenseId),['550e8400-e29b-41d4-a716-446655440000']);
});

test('expense template is UTF-8 and round-trips every supported category',async()=>{
  const categories=['packaging','external_promotion','agency_services','software_services','other_external'];
  const buffer=createExpenseCsvTemplate(categories.map((category,index)=>({category,amount:`${index+1}.25`,periodStart:'2026-09-20',recognitionMethod:'on_date'})));
  const rows=await parseExpenseFile({fileName:'template.csv',buffer});
  assert.deepEqual(rows.map(row=>row.category),categories);
  assert.ok(buffer.toString('utf8').startsWith('\uFEFFID расхода;'));
});
