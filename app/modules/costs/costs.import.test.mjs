import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createCostCsvTemplate, parseCostFile } from './costs.import.mjs';

test('cost CSV accepts Russian headers, decimal comma and date',async()=>{
  const csv='Артикул WB;ID варианта;Штрихкод;Себестоимость, ₽;Действует с\r\n123456;size-1;460000000001;1 234,50;16.09.2026\r\n';
  const rows=await parseCostFile({fileName:'costs.csv',buffer:Buffer.from(csv)});
  assert.deepEqual(rows.map(({wbArticle,externalVariantId,barcode,unitCost,effectiveFrom})=>({wbArticle,externalVariantId,barcode,unitCost,effectiveFrom})),[
    {wbArticle:'123456',externalVariantId:'size-1',barcode:'460000000001',unitCost:'1234.5000',effectiveFrom:'2026-09-16'}
  ]);
});

test('cost XLSX reads the first worksheet without converting identifiers to floating point',async()=>{
  const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('Себестоимость');
  sheet.addRow(['Артикул WB','ID варианта','Штрихкод','Себестоимость','Действует с']);
  sheet.addRow(['90071992547409931','90071992547409941','0460000000001',875.125,new Date('2026-09-01T00:00:00Z')]);
  const buffer=Buffer.from(await workbook.xlsx.writeBuffer());
  const [row]=await parseCostFile({fileName:'costs.xlsx',buffer});
  assert.equal(row.wbArticle,'90071992547409931');
  assert.equal(row.externalVariantId,'90071992547409941');
  assert.equal(row.barcode,'0460000000001');
  assert.equal(row.unitCost,'875.1250');
  assert.equal(row.effectiveFrom,'2026-09-01');
});

test('cost import rejects incomplete rows and legacy XLS',async()=>{
  await assert.rejects(()=>parseCostFile({fileName:'costs.csv',buffer:Buffer.from('Артикул WB;ID варианта;Себестоимость;Действует с\n123;;10;2026-09-01')}),error=>error.message==='cost_variant_missing'&&error.rowNumber===2);
  await assert.rejects(()=>parseCostFile({fileName:'costs.xls',buffer:Buffer.from('legacy')}),/cost_legacy_xls/);
});

test('generated template is UTF-8 CSV, round-trips and neutralizes spreadsheet formulas',async()=>{
  const buffer=createCostCsvTemplate([{wb_article:'123',seller_article:'=HYPERLINK("bad")',external_variant_id:'v1',size_label:'M',barcode:'460',unit_cost:'10.5',effective_from:'2026-09-16'}]);
  const text=buffer.toString('utf8');
  assert.ok(text.startsWith('\uFEFFАртикул WB;'));
  assert.match(text,/"'=HYPERLINK\(""bad""\)"/);
  const [row]=await parseCostFile({fileName:'template.csv',buffer});
  assert.equal(row.unitCost,'10.5000');
});

test('cost import rejects impossible dates, numeric barcodes and formulas',async()=>{
  await assert.rejects(()=>parseCostFile({fileName:'costs.csv',buffer:Buffer.from('Артикул WB;ID варианта;Себестоимость;Действует с\n123;v1;10;2026-02-30')}),error=>error.message==='cost_invalid_date'&&error.rowNumber===2);

  const numericBarcode=new ExcelJS.Workbook(),numericSheet=numericBarcode.addWorksheet('Себестоимость');
  numericSheet.addRow(['Артикул WB','Штрихкод','Себестоимость','Действует с']);
  numericSheet.addRow(['123',4600000000001,10,'2026-09-16']);
  const numericBarcodeBuffer=Buffer.from(await numericBarcode.xlsx.writeBuffer());
  await assert.rejects(()=>parseCostFile({fileName:'numeric-barcode.xlsx',buffer:numericBarcodeBuffer}),error=>error.message==='cost_identifier_format'&&error.rowNumber===2);

  const formulas=new ExcelJS.Workbook(),formulaSheet=formulas.addWorksheet('Себестоимость');
  formulaSheet.addRow(['Артикул WB','ID варианта','Себестоимость','Действует с']);
  formulaSheet.addRow(['123','v1',{formula:'5+5',result:10},'2026-09-16']);
  const formulaBuffer=Buffer.from(await formulas.xlsx.writeBuffer());
  await assert.rejects(()=>parseCostFile({fileName:'formula.xlsx',buffer:formulaBuffer}),/cost_formula_cell/);
});

test('generated template fills a default effective date for new costs',()=>{
  const text=createCostCsvTemplate([{wb_article:'123',seller_article:'SKU',external_variant_id:'v1'}],{defaultEffectiveFrom:'2026-09-19'}).toString('utf8');
  assert.match(text,/123;SKU;v1;;;;2026-09-19/);
});
