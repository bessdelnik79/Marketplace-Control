import ExcelJS from 'exceljs';

export const expenseImportMaxBytes = 5 * 1024 * 1024;
export const expenseImportMaxRows = 10000;
const expenseImportMaxExpandedBytes = 25 * 1024 * 1024;
const expenseImportMaxColumns = 30;
const channelNameMaxLength = 120;
const descriptionMaxLength = 500;

const aliases = {
  expenseId: ['id расхода','ид расхода','expense id','expense_id','uuid'],
  wbArticle: ['артикул wb','wb артикул','артикул wildberries','wb_article','nmid','nm id'],
  category: ['категория','категория расхода','category','expense category','expense_category'],
  amount: ['сумма','сумма ₽','сумма руб','amount','expense amount','expense_amount'],
  periodStart: ['начало периода','дата начала','дата расхода','period start','period_start','date'],
  periodEnd: ['конец периода','дата окончания','period end','period_end'],
  recognitionMethod: ['метод признания','признание','recognition method','recognition_method'],
  channelName: ['канал','название канала','channel','channel name','channel_name'],
  description: ['описание','комментарий','description','comment']
};

const categoryAliases = new Map([
  ['packaging','packaging'],['упаковка','packaging'],
  ['external_promotion','external_promotion'],['external promotion','external_promotion'],['внешнее продвижение','external_promotion'],
  ['agency_services','agency_services'],['agency services','agency_services'],['агентские услуги','agency_services'],
  ['software_services','software_services'],['software services','software_services'],['программные сервисы','software_services'],['сервисы по','software_services'],
  ['other_external','other_external'],['other external','other_external'],['прочие внешние расходы','other_external'],['другие внешние расходы','other_external']
]);

const recognitionAliases = new Map([
  ['on_date','on_date'],['on date','on_date'],['на дату','on_date'],['в дату','on_date'],
  ['evenly_over_period','evenly_over_period'],['evenly over period','evenly_over_period'],['равномерно за период','evenly_over_period'],['равномерно по периоду','evenly_over_period']
]);

const cleanHeader = value => String(value ?? '').replace(/^\uFEFF/,'').trim().toLocaleLowerCase('ru-RU').replace(/[,_–—-]+/g,' ').replace(/\s+/g,' ');
const cleanEnum = value => String(cellValue(value)).trim().toLocaleLowerCase('ru-RU').replace(/[_–—-]+/g,' ').replace(/\s+/g,' ');

function cellValue(value) {
  if (value == null) return '';
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if ('formula' in value || 'sharedFormula' in value) throw new Error('expense_formula_cell');
    if ('result' in value) return cellValue(value.result);
    if (Array.isArray(value.richText)) return value.richText.map(part=>part.text??'').join('');
    if ('text' in value) return value.text;
  }
  return value;
}

function parseDelimited(text,delimiter) {
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
  if(quoted)throw new Error('expense_file_invalid_csv');
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
  if(!/^\d{1,16}(?:\.\d{1,4})?$/.test(clean))throw new Error('expense_invalid_amount');
  const [rawWhole,rawFraction='']=clean.split('.');
  const whole=rawWhole.replace(/^0+(?=\d)/,'');
  const fraction=rawFraction.padEnd(4,'0');
  if(!/[1-9]/.test(`${whole}${fraction}`))throw new Error('expense_invalid_amount');
  return `${whole}.${fraction}`;
}

function parseDate(value) {
  value=cellValue(value);
  if(value instanceof Date&&!Number.isNaN(value.getTime()))return value.toISOString().slice(0,10);
  if(typeof value==='number'&&Number.isFinite(value)){
    const date=new Date(Date.UTC(1899,11,30)+Math.floor(value)*86400000);
    if(!Number.isNaN(date.getTime()))return date.toISOString().slice(0,10);
  }
  const clean=String(value??'').trim();
  const ru=clean.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  const iso=ru?`${ru[3]}-${ru[2].padStart(2,'0')}-${ru[1].padStart(2,'0')}`:clean;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(iso))throw new Error('expense_invalid_date');
  const [year,month,day]=iso.split('-').map(Number),parsed=new Date(Date.UTC(year,month-1,day));
  if(parsed.getUTCFullYear()!==year||parsed.getUTCMonth()!==month-1||parsed.getUTCDate()!==day)throw new Error('expense_invalid_date');
  return iso;
}

function optionalText(value,maxLength,errorCode) {
  const text=String(cellValue(value)??'').trim();
  if(text.length>maxLength||/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text))throw new Error(errorCode);
  return text;
}

function optionalUuid(value) {
  const clean=String(cellValue(value)??'').trim().toLocaleLowerCase('en-US');
  if(clean&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(clean))throw new Error('expense_invalid_id');
  return clean;
}

function optionalArticle(value) {
  value=cellValue(value);
  if(typeof value==='number'){
    if(!Number.isSafeInteger(value)||value<0)throw new Error('expense_invalid_article');
    value=String(value);
  }
  const clean=String(value??'').trim().replace(/\.0$/,'');
  if(clean&&!/^\d+$/.test(clean))throw new Error('expense_invalid_article');
  return clean;
}

function parseEnum(value,accepted,errorCode) {
  const parsed=accepted.get(cleanEnum(value));
  if(!parsed)throw new Error(errorCode);
  return parsed;
}

function validateXlsxArchive(buffer) {
  if(buffer.length<4||buffer.readUInt32LE(0)!==0x04034b50)throw new Error('expense_file_invalid_excel');
  let expanded=0,entries=0,cursor=0;
  while((cursor=buffer.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]),cursor))>=0){
    if(cursor+46>buffer.length)throw new Error('expense_file_invalid_excel');
    const size=buffer.readUInt32LE(cursor+24),nameLength=buffer.readUInt16LE(cursor+28),extraLength=buffer.readUInt16LE(cursor+30),commentLength=buffer.readUInt16LE(cursor+32);
    if(size===0xffffffff)throw new Error('expense_file_expanded_too_large');
    expanded+=size;entries++;
    if(expanded>expenseImportMaxExpandedBytes||entries>200)throw new Error('expense_file_expanded_too_large');
    cursor+=46+nameLength+extraLength+commentLength;
  }
  if(!entries)throw new Error('expense_file_invalid_excel');
}

function mapHeaders(headers) {
  const normalized=headers.map(cleanHeader),mapping={};
  for(const [field,names] of Object.entries(aliases)){
    const accepted=names.map(cleanHeader),indexes=normalized.map((header,index)=>accepted.includes(header)?index:-1).filter(index=>index>=0);
    if(indexes.length>1)throw new Error('expense_duplicate_columns');
    if(indexes.length)mapping[field]=indexes[0];
  }
  if(mapping.category==null||mapping.amount==null||mapping.periodStart==null||mapping.recognitionMethod==null)throw new Error('expense_columns_missing');
  return mapping;
}

function normalizeRows(table) {
  while(table.length&&table.at(-1).every(value=>String(cellValue(value)).trim()===''))table.pop();
  if(table.length<2)throw new Error('expense_file_empty');
  if(table.length-1>expenseImportMaxRows)throw new Error('expense_too_many_rows');
  if(table.some(row=>row.length>expenseImportMaxColumns))throw new Error('expense_too_many_columns');
  const mapping=mapHeaders(table[0]),rows=[];
  for(let index=1;index<table.length;index++){
    const source=table[index];
    if(source.every(value=>String(cellValue(value)).trim()===''))continue;
    const rowNumber=source.sourceRowNumber??index+1;
    try{
      const expenseId=mapping.expenseId==null?'':optionalUuid(source[mapping.expenseId]);
      const wbArticle=mapping.wbArticle==null?'':optionalArticle(source[mapping.wbArticle]);
      const category=parseEnum(source[mapping.category],categoryAliases,'expense_invalid_category');
      const amount=parseDecimal(source[mapping.amount]);
      const periodStart=parseDate(source[mapping.periodStart]);
      const recognitionMethod=parseEnum(source[mapping.recognitionMethod],recognitionAliases,'expense_invalid_recognition_method');
      const rawPeriodEnd=mapping.periodEnd==null?'':String(cellValue(source[mapping.periodEnd])??'').trim();
      const periodEnd=rawPeriodEnd?parseDate(source[mapping.periodEnd]):recognitionMethod==='on_date'?periodStart:'';
      if(!periodEnd)throw new Error('expense_period_end_missing');
      if(periodEnd<periodStart)throw new Error('expense_invalid_period');
      if(recognitionMethod==='on_date'&&periodEnd!==periodStart)throw new Error('expense_on_date_period_mismatch');
      const channelName=mapping.channelName==null?'':optionalText(source[mapping.channelName],channelNameMaxLength,'expense_invalid_channel_name');
      const description=mapping.description==null?'':optionalText(source[mapping.description],descriptionMaxLength,'expense_invalid_description');
      rows.push({
        rowNumber,expenseId,wbArticle,category,amount,periodStart,periodEnd,recognitionMethod,channelName,description,
        rawValues:{expenseId,wbArticle,category,amount,periodStart,periodEnd,recognitionMethod,channelName,description}
      });
    }catch(error){error.rowNumber=rowNumber;throw error;}
  }
  if(!rows.length)throw new Error('expense_file_empty');
  return rows;
}

export async function parseExpenseFile({fileName,buffer}) {
  fileName=String(fileName??'').trim();
  if(!Buffer.isBuffer(buffer)||buffer.length===0)throw new Error('expense_file_empty');
  if(buffer.length>expenseImportMaxBytes)throw new Error('expense_file_too_large');
  const lower=fileName.toLowerCase();
  let table;
  if(lower.endsWith('.csv')||lower.endsWith('.tsv')||lower.endsWith('.txt')){
    let text;
    try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer).replace(/^\uFEFF/,'');}catch{throw new Error('expense_file_encoding');}
    table=parseDelimited(text,delimiterFor(text,lower));
  }else if(lower.endsWith('.xlsx')){
    validateXlsxArchive(buffer);
    const workbook=new ExcelJS.Workbook();
    try{await workbook.xlsx.load(buffer);}catch{throw new Error('expense_file_invalid_excel');}
    const sheet=workbook.worksheets[0];
    if(!sheet)throw new Error('expense_file_empty');
    table=[];
    sheet.eachRow({includeEmpty:false},row=>{
      const values=Array.from({length:row.cellCount},(_,index)=>cellValue(row.getCell(index+1).value));
      values.sourceRowNumber=row.number;
      table.push(values);
    });
  }else if(lower.endsWith('.xls'))throw new Error('expense_legacy_xls');
  else throw new Error('expense_file_type');
  return normalizeRows(table);
}

function csvCell(value) {
  let text=String(value??'');
  if(/^\s*[=+@-]/.test(text))text=`'${text}`;
  return /[;"\r\n]/.test(text)?`"${text.replaceAll('"','""')}"`:text;
}

const csvHeader=['ID расхода','Артикул WB','Категория','Сумма, ₽','Начало периода','Конец периода','Метод признания','Канал','Описание'];

function expenseCsv(rows) {
  const lines=[csvHeader,...rows.map(row=>[
    row.expenseId??row.expense_id??'',row.wbArticle??row.wb_article??'',row.category??'',row.amount??'',
    row.periodStart??row.period_start??'',row.periodEnd??row.period_end??'',row.recognitionMethod??row.recognition_method??'',
    row.channelName??row.channel_name??'',row.description??''
  ])];
  return Buffer.from(`\uFEFF${lines.map(line=>line.map(csvCell).join(';')).join('\r\n')}\r\n`,'utf8');
}

export function createExpenseCsvTemplate(rows=[]) {
  return expenseCsv(rows);
}

export function createExpenseCsvExport(rows=[]) {
  return expenseCsv(rows.filter(row=>row?.state!=='voided'));
}
