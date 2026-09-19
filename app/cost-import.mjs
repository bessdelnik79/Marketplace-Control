import ExcelJS from 'exceljs';

export const costImportMaxBytes = 5 * 1024 * 1024;
export const costImportMaxRows = 10000;
const costImportMaxExpandedBytes = 25 * 1024 * 1024;
const costImportMaxColumns = 30;

const aliases = {
  wbArticle: ['артикул wb','wb артикул','артикул wildberries','wb_article','nmid','nm id'],
  sellerArticle: ['артикул продавца','seller_article','vendorcode','vendor code'],
  externalVariantId: ['id варианта','ид варианта','external_variant_id','chrtid','chrt id'],
  size: ['размер','size','size_label'],
  barcode: ['штрихкод','баркод','barcode','sku'],
  unitCost: ['себестоимость','себестоимость ₽','себестоимость руб','unit_cost','cost'],
  effectiveFrom: ['действует с','дата начала','effective_from','date']
};

const cleanHeader = value => String(value ?? '').replace(/^\uFEFF/,'').trim().toLocaleLowerCase('ru-RU').replace(/[,_–—-]+/g,' ').replace(/\s+/g,' ');

function cellValue(value) {
  if (value == null) return '';
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if ('formula' in value || 'sharedFormula' in value) throw new Error('cost_formula_cell');
    if ('result' in value) return cellValue(value.result);
    if (Array.isArray(value.richText)) return value.richText.map(part=>part.text??'').join('');
    if ('text' in value) return value.text;
  }
  return value;
}

function parseDelimited(text, delimiter) {
  const rows=[];
  let row=[],field='',quoted=false;
  for(let index=0;index<text.length;index++){
    const char=text[index];
    if(quoted){
      if(char==='"'&&text[index+1]==='"'){field+='"';index++;}
      else if(char==='"')quoted=false;
      else field+=char;
    }else if(char==='"'&&field==='')quoted=true;
    else if(char===delimiter){row.push(field);field='';}
    else if(char==='\n'){row.push(field.replace(/\r$/,''));rows.push(row);row=[];field='';}
    else field+=char;
  }
  if(quoted)throw new Error('cost_file_invalid_csv');
  if(field!==''||row.length){row.push(field.replace(/\r$/,''));rows.push(row);}
  return rows;
}

function delimiterFor(text,fileName) {
  if(fileName.toLowerCase().endsWith('.tsv'))return '\t';
  const first=String(text).split(/\r?\n/,1)[0]??'';
  const counts={';':(first.match(/;/g)||[]).length,',':(first.match(/,/g)||[]).length,'\t':(first.match(/\t/g)||[]).length};
  const [delimiter,count]=Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
  return count>0?delimiter:';';
}

function parseDecimal(value) {
  const clean=String(cellValue(value)).trim().replace(/[\s\u00A0₽]/g,'').replace(',','.');
  if(!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/.test(clean))throw new Error('cost_invalid_amount');
  const [whole,fraction='']=clean.split('.');
  return `${whole}.${fraction.padEnd(4,'0')}`;
}

function parseDate(value) {
  value=cellValue(value);
  if(value instanceof Date&&!Number.isNaN(value.getTime()))return value.toISOString().slice(0,10);
  if(typeof value==='number'&&Number.isFinite(value)){
    const date=new Date(Date.UTC(1899,11,30)+Math.floor(value)*86400000);
    if(!Number.isNaN(date.getTime()))return date.toISOString().slice(0,10);
  }
  const clean=String(value??'').trim();
  const ru=clean.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  const iso=ru?`${ru[3]}-${ru[2].padStart(2,'0')}-${ru[1].padStart(2,'0')}`:clean;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(iso))throw new Error('cost_invalid_date');
  const [year,month,day]=iso.split('-').map(Number),parsed=new Date(Date.UTC(year,month-1,day));
  if(parsed.getUTCFullYear()!==year||parsed.getUTCMonth()!==month-1||parsed.getUTCDate()!==day)throw new Error('cost_invalid_date');
  return iso;
}

function identifier(value,{allowNumeric=true}={}) {
  value=cellValue(value);
  if(typeof value==='number'){
    if(!allowNumeric||!Number.isSafeInteger(value)||value<0)throw new Error('cost_identifier_format');
    return String(value);
  }
  return String(value??'').trim().replace(/\.0$/,'');
}

function validateXlsxArchive(buffer) {
  if(buffer.length<4||buffer.readUInt32LE(0)!==0x04034b50)throw new Error('cost_file_invalid_excel');
  let expanded=0,entries=0,cursor=0;
  while((cursor=buffer.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]),cursor))>=0){
    if(cursor+46>buffer.length)throw new Error('cost_file_invalid_excel');
    const size=buffer.readUInt32LE(cursor+24),nameLength=buffer.readUInt16LE(cursor+28),extraLength=buffer.readUInt16LE(cursor+30),commentLength=buffer.readUInt16LE(cursor+32);
    if(size===0xffffffff)throw new Error('cost_file_expanded_too_large');
    expanded+=size;entries++;if(expanded>costImportMaxExpandedBytes||entries>200)throw new Error('cost_file_expanded_too_large');
    cursor+=46+nameLength+extraLength+commentLength;
  }
  if(!entries)throw new Error('cost_file_invalid_excel');
}

function mapHeaders(headers) {
  const normalized=headers.map(cleanHeader),mapping={};
  for(const [field,names] of Object.entries(aliases)){
    const accepted=names.map(cleanHeader),indexes=normalized.map((header,index)=>accepted.includes(header)?index:-1).filter(index=>index>=0);
    if(indexes.length>1)throw new Error('cost_duplicate_columns');
    if(indexes.length)mapping[field]=indexes[0];
  }
  if(mapping.wbArticle==null||mapping.unitCost==null||mapping.effectiveFrom==null)throw new Error('cost_columns_missing');
  if(mapping.externalVariantId==null&&mapping.barcode==null)throw new Error('cost_variant_column_missing');
  return mapping;
}

function normalizeRows(table) {
  while(table.length&&table.at(-1).every(value=>String(cellValue(value)).trim()===''))table.pop();
  if(table.length<2)throw new Error('cost_file_empty');
  if(table.length-1>costImportMaxRows)throw new Error('cost_too_many_rows');
  if(table[0].length>costImportMaxColumns)throw new Error('cost_too_many_columns');
  const mapping=mapHeaders(table[0]),rows=[];
  for(let index=1;index<table.length;index++){
    const source=table[index];
    if(source.every(value=>String(cellValue(value)).trim()===''))continue;
    const sourceRowNumber=source.sourceRowNumber??index+1;
    let wbArticle,externalVariantId,barcode;
    try{
      wbArticle=identifier(source[mapping.wbArticle]);
      externalVariantId=mapping.externalVariantId==null?'':identifier(source[mapping.externalVariantId]);
      barcode=mapping.barcode==null?'':identifier(source[mapping.barcode],{allowNumeric:false});
    }catch(error){error.rowNumber=sourceRowNumber;throw error;}
    if(!/^\d+$/.test(wbArticle))throw Object.assign(new Error('cost_invalid_article'),{rowNumber:sourceRowNumber});
    if(!externalVariantId&&!barcode)throw Object.assign(new Error('cost_variant_missing'),{rowNumber:sourceRowNumber});
    let unitCost,effectiveFrom;
    try{unitCost=parseDecimal(source[mapping.unitCost]);}catch(error){error.rowNumber=sourceRowNumber;throw error;}
    try{effectiveFrom=parseDate(source[mapping.effectiveFrom]);}catch(error){error.rowNumber=sourceRowNumber;throw error;}
    rows.push({
      rowNumber:sourceRowNumber,wbArticle,externalVariantId,barcode,unitCost,effectiveFrom,
      rawValues:{
        wbArticle,sellerArticle:mapping.sellerArticle==null?'':String(cellValue(source[mapping.sellerArticle])).trim(),
        externalVariantId,size:mapping.size==null?'':String(cellValue(source[mapping.size])).trim(),barcode,unitCost,effectiveFrom
      }
    });
  }
  if(!rows.length)throw new Error('cost_file_empty');
  return rows;
}

export async function parseCostFile({fileName,buffer}) {
  fileName=String(fileName??'').trim();
  if(!Buffer.isBuffer(buffer)||buffer.length===0)throw new Error('cost_file_empty');
  if(buffer.length>costImportMaxBytes)throw new Error('cost_file_too_large');
  const lower=fileName.toLowerCase();
  let table;
  if(lower.endsWith('.csv')||lower.endsWith('.tsv')||lower.endsWith('.txt')){
    let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer).replace(/^\uFEFF/,'');}catch{throw new Error('cost_file_encoding');}
    table=parseDelimited(text,delimiterFor(text,lower));
  }else if(lower.endsWith('.xlsx')){
    validateXlsxArchive(buffer);
    const workbook=new ExcelJS.Workbook();
    try{await workbook.xlsx.load(buffer);}catch{throw new Error('cost_file_invalid_excel');}
    const sheet=workbook.worksheets[0];
    if(!sheet)throw new Error('cost_file_empty');
    table=[];
    sheet.eachRow({includeEmpty:false},row=>{const values=Array.from({length:row.cellCount},(_,index)=>cellValue(row.getCell(index+1).value));values.sourceRowNumber=row.number;table.push(values);});
  }else if(lower.endsWith('.xls'))throw new Error('cost_legacy_xls');
  else throw new Error('cost_file_type');
  return normalizeRows(table);
}

function csvCell(value) {
  let text=String(value??'');
  if(/^[=+@-]/.test(text))text=`'${text}`;
  return /[;"\r\n]/.test(text)?`"${text.replaceAll('"','""')}"`:text;
}

export function createCostCsvTemplate(rows,{defaultEffectiveFrom=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow'}).format(new Date())}={}) {
  const header=['Артикул WB','Артикул продавца','ID варианта','Размер','Штрихкод','Себестоимость, ₽','Действует с'];
  const lines=[header,...rows.map(row=>[row.wb_article,row.seller_article,row.external_variant_id,row.size_label??'',row.barcode??'',row.unit_cost??'',row.effective_from??defaultEffectiveFrom])];
  return Buffer.from(`\uFEFF${lines.map(line=>line.map(csvCell).join(';')).join('\r\n')}\r\n`,'utf8');
}
