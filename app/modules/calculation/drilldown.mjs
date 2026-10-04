import { createHash } from 'node:crypto';
import { buildFinancialPeriodOverview, financialResultIncludesStore, parseScale4Money, formatScale4Money, validateCalendarPeriod } from '../overview/financial-overview.mjs';
import { aggregateDailyFinancialGeneration } from './daily-generation.mjs';

const externalCategories=new Set(['packaging','software_services','external_promotion','agency_services','other_external']);
const revenueCategories=new Set(['revenue','revenue_return']);
const wbCategories=new Set(['acquiring','logistics','storage','acceptance','penalty','deduction','commission_adjustment','other_adjustment','promotion','pickup_reward','wb_reward_without_vat','wb_reward_vat','return_wb_expense_reversal','wb_row_rounding_adjustment']);
const sorts=new Set(['result_asc','result_desc','revenue_asc','revenue_desc']);
function invalid(code='drilldown_invalid_request'){throw new Error(code);}
function money(value){try{return parseScale4Money(value);}catch{invalid();}}
function sum(lines){return lines.reduce((total,line)=>total+money(line.amountSigned),0n);}
function decimal12(value){
  const match=typeof value==='string'&&value.match(/^([+-]?)(\d+)(?:\.(\d{1,12}))?$/);
  if(!match)invalid();
  const amount=BigInt(`${match[2]}${(match[3]??'').padEnd(12,'0')}`);
  return match[1]==='-'?-amount:amount;
}
function rate8(value){
  const canonical=typeof value==='string'?value.replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,''):null;
  const match=canonical?.match(/^(\d+)(?:\.(\d{1,8}))?$/);
  if(!match)invalid();
  const rate=BigInt(`${match[1]}${(match[2]??'').padEnd(8,'0')}`);if(rate>100000000n)invalid();return rate;
}
function format12(value){const digits=(value<0n?-value:value).toString().padStart(13,'0');return `${value<0n?'-':''}${digits.slice(0,-12)}.${digits.slice(-12)}`;}
function taxAmount(facts,date){
  const numerator=facts.reduce((total,fact)=>total+decimal12(fact.taxNumeratorUnrounded),0n);
  // The existing aggregator owns half-away-from-zero rounding. Its aggregate
  // nonnegative guard is applied to the complete scope below, not each SKU.
  const result=aggregateDailyFinancialGeneration({periodStart:date,periodEnd:date,
    days:[{accountingDate:date,coverageComplete:true,taxUsable:true,quality:'complete',missingReasons:[],selectedProductsResultBeforeTax:'0.0000',storeLevelResultBeforeTax:'0.0000',availableResultBeforeTax:'0.0000'}],
    taxFacts:[{accountingDate:date,productId:'rounding',taxableBase:'0.000000000000',numerator:format12(numerator<0n?-numerator:numerator)}]});
  const rounded=money(result.totals.estimatedUsnTax);
  return formatScale4Money(numerator<0n?-rounded:rounded);
}
function overviewLine(line){return {result_scope:line.scope,product_id:line.productId,accounting_date:line.accountingDate,category_code:line.categoryCode,amount_signed:line.amountSigned,quality:line.quality};}
function groupLines(lines){
  const groups=new Map();
  for(const line of lines){
    const groupKey=JSON.stringify([line.scope,line.productId??null,line.categoryCode]);
    const group=groups.get(groupKey)??{groupKey,scope:line.scope,productId:line.productId??null,categoryCode:line.categoryCode,amountSigned:'0.0000',lineCount:0,lineRefs:[],evidenceStatus:'unchecked',missingReasons:[]};
    group.amountSigned=formatScale4Money(money(group.amountSigned)+money(line.amountSigned));
    group.lineCount+=1;group.lineRefs.push(line.lineRef);groups.set(groupKey,group);
  }
  return [...groups.values()].sort((a,b)=>a.groupKey.localeCompare(b.groupKey));
}
function metric(groups,predicate,{quality,negate=false,basis='signed_contribution',forceUnavailable=false}={}){
  const selected=groups.filter(predicate),available=!forceUnavailable&&quality!=='unavailable'&&(quality==='complete'||selected.length>0);
  const signed=available?selected.reduce((total,group)=>total+money(group.amountSigned),0n):null;
  return {amount:signed===null?null:formatScale4Money(negate?-signed:signed),amountSigned:signed===null?null:formatScale4Money(signed),basis,
    availability:available?(quality==='complete'?'complete':'partial'):'unavailable',missingReasons:available?[]:['drilldown_metric_unavailable'],groupKeys:selected.map(group=>group.groupKey)};
}
export function buildPublishedDrilldownModel({context,envelope,products,lines,taxFacts=[]}){
  if(!context||!envelope||!Array.isArray(products)||!Array.isArray(lines)||!Array.isArray(taxFacts)||!Array.isArray(context.scope?.productIds))invalid();
  let period;try{period=validateCalendarPeriod(context.period);}catch{invalid();}
  if(!['complete','partial','unavailable'].includes(context.quality)||context.quality!==envelope.quality||
    period.start!==(envelope.period_start??envelope.periodStart)||period.end!==(envelope.period_end??envelope.periodEnd)||
    context.publication?.id!==(envelope.publication_id??envelope.publicationId)||
    context.method?.version!==(envelope.method_version??envelope.methodVersion))invalid();
  const ids=context.scope.productIds,scope=new Set(ids);
  if(ids.some(id=>typeof id!=='string'||!id)||scope.size!==ids.length)invalid();
  const seen=new Set();
  for(const line of lines){
    if(!line.lineRef||!['selected_product','store'].includes(line.scope)||typeof line.categoryCode!=='string'||!line.categoryCode||
      line.scope==='selected_product'&&!scope.has(line.productId)||line.scope==='store'&&line.productId!==null||
      !['complete','partial','unavailable'].includes(line.quality))invalid();
    try{validateCalendarPeriod({start:line.accountingDate,end:line.accountingDate});}catch{invalid();}
    if(line.accountingDate<period.start||line.accountingDate>period.end)invalid();
    money(line.amountSigned);
    const key=JSON.stringify(line.lineRef);if(seen.has(key))invalid();seen.add(key);
  }
  for(const fact of taxFacts){
    if(!scope.has(fact.productId)||!fact.id||!fact.generationId||!fact.taxSettingVersionId||fact.accountingDate<period.start||fact.accountingDate>period.end)invalid();
    try{validateCalendarPeriod({start:fact.accountingDate,end:fact.accountingDate});}catch{invalid();}
    decimal12(fact.taxBaseUnrounded);decimal12(fact.taxNumeratorUnrounded);rate8(fact.taxRateFraction);
    const key=JSON.stringify([fact.generationId,fact.id]);if(seen.has(key))invalid();seen.add(key);
  }
  const usable=envelope.taxReference?.usable===true&&envelope.taxReference?.includedInResult===true;
  const taxByProduct=new Map();for(const fact of taxFacts){const facts=taxByProduct.get(fact.productId)??[];facts.push(fact);taxByProduct.set(fact.productId,facts);}
  const normalized=lines.filter(line=>!taxFacts.length||line.categoryCode!=='estimated_usn_tax').map(line=>({...line}));
  if(usable)for(const[productId,facts]of taxByProduct){normalized.push({scope:'selected_product',productId,categoryCode:'estimated_usn_tax',accountingDate:period.end,
    quality:context.quality,amountSigned:formatScale4Money(-money(taxAmount(facts,period.end))),
    lineRef:{source:'daily_tax_range',productId,period:{start:period.start,end:period.end},taxFactRefs:facts.map(fact=>({id:fact.id,generationId:fact.generationId,accountingDate:fact.accountingDate,taxSettingVersionId:fact.taxSettingVersionId}))}});}
  const catalog=new Map(products.map(product=>[product.productId,product]));
  const items=ids.map(productId=>{
    const metadata=catalog.get(productId),productLines=normalized.filter(line=>line.scope==='selected_product'&&line.productId===productId),groups=groupLines(productLines);
    const unknown=groups.filter(group=>!revenueCategories.has(group.categoryCode)&&!externalCategories.has(group.categoryCode)&&!wbCategories.has(group.categoryCode)&&!['cost_of_goods','estimated_usn_tax'].includes(group.categoryCode));
    const quality=context.quality==='unavailable'?'unavailable':context.quality==='partial'||unknown.length?'partial':'complete';
    const opts={quality};
    const metrics={revenue:metric(groups,g=>revenueCategories.has(g.categoryCode),opts),wbExpenses:metric(groups,g=>wbCategories.has(g.categoryCode),{...opts,negate:true,basis:'expense_negated'}),
      costOfGoods:metric(groups,g=>g.categoryCode==='cost_of_goods',{...opts,negate:true,basis:'expense_negated'}),externalExpenses:metric(groups,g=>externalCategories.has(g.categoryCode),{...opts,negate:true,basis:'expense_negated'}),
      tax:metric(groups,g=>g.categoryCode==='estimated_usn_tax',{...opts,negate:true,basis:'tax_negated',forceUnavailable:!usable}),
      availableResultBeforeTax:metric(groups,g=>g.categoryCode!=='estimated_usn_tax',{...opts,basis:'before_tax'}),
      availableResultAfterTax:metric(groups,()=>true,{...opts,basis:'after_tax',forceUnavailable:!usable||quality==='partial'&&!groups.some(g=>g.categoryCode==='estimated_usn_tax')})};
    return {productId,name:metadata?.name??null,sellerArticle:metadata?.sellerArticle??null,wbArticle:metadata?.wbArticle??null,imageUrl:metadata?.imageUrl??null,isHistorical:metadata?.isHistorical??!metadata,
      quality,missingReasons:unknown.map(group=>({code:'drilldown_category_unsupported',scope:'selected_product',productId,categoryCode:group.categoryCode})),metrics,groups};
  });
  const checks=[];
  function check(code,actual,expected,checkScope='full_scope'){
    const status=actual===null||expected===null||expected===undefined?'unavailable':money(actual)===money(expected)?'matched':'mismatch';
    checks.push({code,expected:expected??null,actual,scope:checkScope,status,reason:status==='mismatch'?'drilldown_reconciliation_mismatch':status==='unavailable'?'drilldown_metric_unavailable':null});
  }
  const selected=normalized.filter(line=>line.scope==='selected_product'&&line.categoryCode!=='estimated_usn_tax'),store=normalized.filter(line=>line.scope==='store'&&line.categoryCode!=='estimated_usn_tax');
  const available=context.quality!=='unavailable',selectedSum=available?formatScale4Money(sum(selected)):null,storeSum=available?formatScale4Money(sum(store)):null;
  const storeIncluded=financialResultIncludesStore(envelope.method_version??envelope.methodVersion);
  if(context.scope.includesStoreResult!==undefined&&context.scope.includesStoreResult!==storeIncluded)invalid();
  check('selected_products_before_tax',selectedSum,envelope.totals?.selectedProductsResultBeforeTax);
  check('store_before_tax',storeSum,envelope.totals?.storeLevelResultBeforeTax);
  check('available_before_tax',available?formatScale4Money(sum(selected)+(storeIncluded?sum(store):0n)):null,envelope.totals?.availableResultBeforeTax);
  if(usable){
    const taxSum=normalized.filter(line=>line.categoryCode==='estimated_usn_tax');
    check('tax_contributions',formatScale4Money(-sum(taxSum)),envelope.totals?.estimatedUsnTax);
    check('available_after_tax',available?formatScale4Money(sum(selected)+(storeIncluded?sum(store):0n)+sum(taxSum)):null,envelope.totals?.availableResultAfterTax);
    if(money(envelope.totals?.estimatedUsnTax)<0n)checks.push({code:'tax_aggregate_amount',expected:'nonnegative',actual:envelope.totals.estimatedUsnTax,scope:'full_scope',status:'mismatch',reason:'tax_base_negative_unverified'});
    if(taxFacts.length){
      const base=taxFacts.reduce((total,fact)=>total+decimal12(fact.taxBaseUnrounded),0n);
      if(base<0n)checks.push({code:'tax_aggregate_base',expected:'nonnegative',actual:format12(base),scope:'full_scope',status:'mismatch',reason:'tax_base_negative_unverified'});
      for(const fact of taxFacts){
        const valid=decimal12(fact.taxBaseUnrounded)*rate8(fact.taxRateFraction)===decimal12(fact.taxNumeratorUnrounded)*100000000n;
        checks.push({code:'tax_fact_numerator',expected:fact.taxNumeratorUnrounded,actual:fact.taxNumeratorUnrounded,scope:{productId:fact.productId,taxFactId:fact.id,generationId:fact.generationId},status:valid?'matched':'mismatch',reason:valid?null:'drilldown_reconciliation_mismatch'});
      }
    }
  }
  try{
    const published=buildFinancialPeriodOverview(envelope),read=buildFinancialPeriodOverview({...envelope,lines:normalized.map(overviewLine)});
    for(const key of ['revenue','wbExpenses','costOfGoods','toTransfer'])check(`overview_${key}`,read.totals[key],published.totals[key]);
  }catch(error){checks.push({code:'overview_composition',expected:null,actual:null,scope:'full_scope',status:'mismatch',reason:'drilldown_reconciliation_mismatch'});}
  const status=checks.some(check=>check.status==='mismatch')?'mismatch':checks.some(check=>check.status==='unavailable')?'unavailable':'matched';
  if(status==='mismatch')for(const item of items)for(const group of item.groups){group.evidenceStatus='unavailable';group.missingReasons.push('drilldown_reconciliation_mismatch');}
  const storeLines=groupLines(normalized.filter(line=>line.scope==='store'));
  if(status==='mismatch')for(const group of storeLines){group.evidenceStatus='unavailable';group.missingReasons.push('drilldown_reconciliation_mismatch');}
  return {context,items,storeLines,reconciliation:{status,checks}};
}

function stable(value){if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]));return value;}
function digest(value){return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');}
export function paginatePublishedSkuList(model,{search='',sort='result_asc',cursor=null,limit=25}={}){
  if(typeof search!=='string'||search.length>256||!sorts.has(sort)||!Number.isInteger(limit)||limit<1||limit>100||cursor!==null&&typeof cursor!=='string')invalid();
  const {contractVersion,publication,storeId,period,method,scope}=model.context;
  const filter=search.trim().toLocaleLowerCase('ru'),binding=digest({context:{contractVersion,publication,storeId,period,method,scope},search:filter,sort});
  const metricKey=sort.startsWith('revenue_')?'revenue':model.context.resultBasis==='after_tax'?'availableResultAfterTax':'availableResultBeforeTax';
  const amount=item=>item.metrics[metricKey].amount;
  const ordered=model.items.filter(item=>!filter||[item.name,item.sellerArticle,item.wbArticle].some(value=>String(value??'').toLocaleLowerCase('ru').includes(filter))).sort((a,b)=>{
    const left=amount(a),right=amount(b);if(left===null&&right!==null)return 1;if(right===null&&left!==null)return -1;
    const comparison=left===null?0:money(left)<money(right)?-1:money(left)>money(right)?1:0;
    return comparison*(sort.endsWith('_desc')?-1:1)||a.productId.localeCompare(b.productId);
  });
  let start=0;
  if(cursor!==null){
    let decoded;try{if(cursor.length>4096||!/^[A-Za-z0-9_-]+$/.test(cursor))invalid();decoded=JSON.parse(Buffer.from(cursor,'base64url').toString());}catch{invalid();}
    if(decoded?.binding!==binding)invalid('drilldown_cursor_context_mismatch');
    if(decoded.checksum!==digest({binding:decoded.binding,last:decoded.last}))invalid();
    const index=ordered.findIndex(item=>item.productId===decoded.last?.productId&&amount(item)===decoded.last?.amount);if(index<0)invalid();start=index+1;
  }
  const items=ordered.slice(start,start+limit),last=items.at(-1),payload=last?{binding,last:{productId:last.productId,amount:amount(last)}}:null;
  const nextCursor=start+items.length<ordered.length?Buffer.from(JSON.stringify({...payload,checksum:digest(payload)})).toString('base64url'):null;
  return {...model,items,totalItems:ordered.length,scopeItemCount:model.items.length,nextCursor};
}
