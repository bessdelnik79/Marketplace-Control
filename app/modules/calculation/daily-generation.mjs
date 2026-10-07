const MONEY_SCALE=4;
const RATE_SCALE=8;
const NUMERATOR_SCALE=MONEY_SCALE+RATE_SCALE;
const qualityRank={complete:0,partial:1,unavailable:2};

function invalid(code){throw new Error(code);}

function decimal(value,scale,code){
  const match=String(value??'').trim().match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if(!match||(match[3]?.length??0)>scale)invalid(code);
  let result=BigInt(`${match[2]}${(match[3]??'').padEnd(scale,'0')}`);
  if(match[1]==='-')result=-result;
  return result;
}

function format(value,scale=MONEY_SCALE){
  const negative=value<0n,absolute=negative?-value:value;
  const digits=absolute.toString().padStart(scale+1,'0');
  const text=scale?`${digits.slice(0,-scale)}.${digits.slice(-scale)}`:digits;
  return negative&&absolute!==0n?`-${text}`:text;
}

function dateNumber(value){
  const text=String(value??'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(text))invalid('daily_generation_invalid_date');
  const[year,month,day]=text.split('-').map(Number),date=new Date(Date.UTC(year,month-1,day));
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)invalid('daily_generation_invalid_date');
  return Math.trunc(date.getTime()/86400000);
}

function dateFromNumber(value){return new Date(value*86400000).toISOString().slice(0,10);}

function range(periodStart,periodEnd){
  const start=dateNumber(periodStart),end=dateNumber(periodEnd);
  if(end<start||end-start>365)invalid('daily_generation_invalid_period');
  return{periodStart:String(periodStart),periodEnd:String(periodEnd),start,end};
}

function orderedReasons(reasons){return[...new Set(reasons??[])].map(String).sort();}

function roundNumerator(value){
  const divisor=10n**BigInt(RATE_SCALE),absolute=value<0n?-value:value;
  const rounded=(absolute+divisor/2n)/divisor;
  return value<0n?-rounded:rounded;
}

function lineKey(line){return JSON.stringify([line.accountingDate,line.scopeCode,line.productId??null,line.variantId??null,line.categoryCode]);}

export function buildDailyFinancialGeneration({periodStart,periodEnd,result,taxReference,coverageComplete=true}){
  const target=range(periodStart,periodEnd);
  if(!result||!(result.quality in qualityRank)||!Array.isArray(result.lines))invalid('daily_generation_invalid_result');
  const reasons=orderedReasons(result.missingReasons);
  const days=[];
  for(let day=target.start;day<=target.end;day++)days.push({
    accountingDate:dateFromNumber(day),coverageComplete:Boolean(coverageComplete),taxUsable:taxReference?.usable===true,quality:result.quality,
    missingReasons:reasons,selectedProductsResultBeforeTax:'0.0000',storeLevelResultBeforeTax:'0.0000',
    availableResultBeforeTax:'0.0000'
  });
  const daysByDate=new Map(days.map(day=>[day.accountingDate,day]));
  const lines=[];
  for(const source of result.lines){
    if(source.categoryCode==='estimated_usn_tax')continue;
    const day=daysByDate.get(String(source.accountingDate));
    if(!day)invalid('daily_generation_line_outside_period');
    if(!['selected_product','store'].includes(source.scopeCode))invalid('daily_generation_invalid_scope');
    const amount=decimal(source.amountSigned,MONEY_SCALE,'daily_generation_invalid_amount');
    const key=source.scopeCode==='selected_product'?'selectedProductsResultBeforeTax':'storeLevelResultBeforeTax';
    day[key]=format(decimal(day[key],MONEY_SCALE,'daily_generation_invalid_amount')+amount);
    day.availableResultBeforeTax=format(
      decimal(day.selectedProductsResultBeforeTax,MONEY_SCALE,'daily_generation_invalid_amount')+
      decimal(day.storeLevelResultBeforeTax,MONEY_SCALE,'daily_generation_invalid_amount')
    );
    lines.push({
      key:lineKey(source),accountingDate:String(source.accountingDate),scopeCode:source.scopeCode,
      productId:source.productId??null,variantId:source.variantId??null,categoryCode:String(source.categoryCode),
      amountSigned:format(amount),evidence:(source.evidence??[]).map(item=>({...item}))
    });
  }
  if(result.totals===null||result.quality==='unavailable')for(const day of days){
    day.selectedProductsResultBeforeTax=null;
    day.storeLevelResultBeforeTax=null;
    day.availableResultBeforeTax=null;
  }
  const taxUsable=taxReference?.usable===true;
  const facts=new Map();
  if(taxUsable){
    for(const segment of taxReference.segments??[]){
      const productId=String(segment.productId??'');
      const settingId=String(segment.taxSettingVersionId??'');
      if(!productId||!settingId||!Array.isArray(segment.evidence))invalid('daily_tax_evidence_missing');
      const rate=decimal(segment.rateFraction,RATE_SCALE,'daily_generation_invalid_tax_rate');
      if(rate<0n||rate>10n**BigInt(RATE_SCALE))invalid('daily_generation_invalid_tax_rate');
      for(const evidence of segment.evidence){
        const accountingDate=String(evidence.accountingDate??'');
        if(!daysByDate.has(accountingDate))invalid('daily_generation_tax_outside_period');
        const contribution=decimal(evidence.contributionAmount,MONEY_SCALE,'daily_generation_invalid_tax_base');
        const key=JSON.stringify([accountingDate,productId,settingId,format(rate,RATE_SCALE)]);
        const fact=facts.get(key)??{accountingDate,productId,taxSettingVersionId:settingId,rateFraction:format(rate,RATE_SCALE),taxableBase:0n,numerator:0n,evidence:[]};
        fact.taxableBase+=contribution;
        fact.numerator+=contribution*rate;
        fact.evidence.push({sourceId:String(evidence.sourceId??''),contributionAmount:format(contribution)});
        facts.set(key,fact);
      }
    }
  }
  return{
    periodStart:target.periodStart,periodEnd:target.periodEnd,quality:result.quality,missingReasons:reasons,
    coverageComplete:Boolean(coverageComplete),taxUsable,days,lines,
    taxFacts:[...facts.values()].map(fact=>({...fact,taxableBase:format(fact.taxableBase),numerator:format(fact.numerator,NUMERATOR_SCALE)}))
      .sort((a,b)=>a.accountingDate.localeCompare(b.accountingDate)||a.productId.localeCompare(b.productId)||a.taxSettingVersionId.localeCompare(b.taxSettingVersionId))
  };
}

export function aggregateDailyFinancialGeneration(generation,{periodStart=generation?.periodStart,periodEnd=generation?.periodEnd}={}){
  const target=range(periodStart,periodEnd),days=(generation?.days??[]).filter(day=>day.accountingDate>=target.periodStart&&day.accountingDate<=target.periodEnd)
    .sort((a,b)=>a.accountingDate.localeCompare(b.accountingDate));
  if(days.length!==target.end-target.start+1||days.some((day,index)=>day.accountingDate!==dateFromNumber(target.start+index)||day.coverageComplete!==true)){
    return{quality:'unavailable',missingReasons:orderedReasons([...(generation?.missingReasons??[]),'report_coverage_incomplete']),totals:null};
  }
  let quality=days.reduce((current,day)=>qualityRank[day.quality]>qualityRank[current]?day.quality:current,'complete');
  let missingReasons=orderedReasons(days.flatMap(day=>day.missingReasons??[]));
  if(days.some(day=>day.availableResultBeforeTax===null))return{quality:'unavailable',missingReasons,totals:null};
  const selected=days.reduce((sum,day)=>sum+decimal(day.selectedProductsResultBeforeTax,MONEY_SCALE,'daily_generation_invalid_amount'),0n);
  const store=days.reduce((sum,day)=>sum+decimal(day.storeLevelResultBeforeTax,MONEY_SCALE,'daily_generation_invalid_amount'),0n);
  let tax=null;
  if(days.every(day=>day.taxUsable===true)){
    const numerators=new Map();
    let taxBase=0n;
    for(const fact of generation.taxFacts??[]){
      if(fact.accountingDate<target.periodStart||fact.accountingDate>target.periodEnd)continue;
      taxBase+=decimal(fact.taxableBase,NUMERATOR_SCALE,'daily_generation_invalid_tax_base');
      numerators.set(fact.productId,(numerators.get(fact.productId)??0n)+decimal(fact.numerator,NUMERATOR_SCALE,'daily_generation_invalid_tax_numerator'));
    }
    tax=[...numerators.values()].reduce((sum,value)=>sum+roundNumerator(value),0n);
    if(taxBase<0n||tax<0n){
      tax=null;
      quality=quality==='unavailable'?'unavailable':'partial';
      missingReasons=orderedReasons([...missingReasons,'tax_base_negative_unverified']);
    }
  }
  return{quality,missingReasons,totals:{
    selectedProductsResultBeforeTax:format(selected),storeLevelResultBeforeTax:format(store),availableResultBeforeTax:format(selected+store),
    estimatedUsnTax:tax===null?null:format(tax),availableResultAfterTax:tax===null?null:format(selected+store-tax),netProfit:null
  }};
}

export function combineDailyFinancialGenerations(generations){
  if(!Array.isArray(generations)||!generations.length)invalid('daily_generation_invalid_result');
  const ordered=[...generations].sort((a,b)=>a.periodStart.localeCompare(b.periodStart));
  const days=ordered.flatMap(item=>item.days),seen=new Set();
  for(const day of days)if(seen.has(day.accountingDate))invalid('daily_generation_overlapping_periods');else seen.add(day.accountingDate);
  const reasons=orderedReasons(ordered.flatMap(item=>item.missingReasons));
  const quality=ordered.reduce((current,item)=>qualityRank[item.quality]>qualityRank[current]?item.quality:current,'complete');
  return{
    periodStart:ordered[0].periodStart,periodEnd:ordered.at(-1).periodEnd,quality,missingReasons:reasons,
    coverageComplete:ordered.every(item=>item.coverageComplete),taxUsable:ordered.every(item=>item.taxUsable),
    days:days.sort((a,b)=>a.accountingDate.localeCompare(b.accountingDate)),
    lines:ordered.flatMap(item=>item.lines).sort((a,b)=>a.accountingDate.localeCompare(b.accountingDate)||a.key.localeCompare(b.key)),
    taxFacts:ordered.flatMap(item=>item.taxFacts).sort((a,b)=>a.accountingDate.localeCompare(b.accountingDate)||a.productId.localeCompare(b.productId))
  };
}

export function compareDailyGenerationToLegacy(generation,legacy){
  const daily=aggregateDailyFinancialGeneration(generation,{periodStart:legacy?.period_start,periodEnd:legacy?.period_end});
  const mismatches=[];
  if(daily.quality!==legacy?.quality)mismatches.push('quality');
  if(JSON.stringify(orderedReasons(daily.missingReasons))!==JSON.stringify(orderedReasons(legacy?.missing_reasons)))mismatches.push('missing_reasons');
  // Legacy totals use zero when no tax was calculated. Match that sentinel to
  // unknown only with explicit tax incompleteness; published amounts stay intact.
  const legacyTaxUnknown=legacy?.quality==='partial'&&legacy?.totals?.estimatedUsnTax==='0.0000'
    &&legacy.totals.availableResultAfterTax===null&&daily.totals?.estimatedUsnTax===null
    &&daily.totals.availableResultAfterTax===null
    &&['tax_setting_missing','tax_selected_reference_only','tax_method_unsupported','tax_source_unverified',
      'tax_source_unlinked','tax_base_missing','tax_base_negative_unverified']
      .some(reason=>legacy.missing_reasons?.includes(reason));
  for(const key of ['selectedProductsResultBeforeTax','storeLevelResultBeforeTax','availableResultBeforeTax','estimatedUsnTax','availableResultAfterTax','netProfit']){
    const legacyValue=key==='estimatedUsnTax'&&legacyTaxUnknown?null:legacy?.totals?.[key]??null;
    if((daily.totals?.[key]??null)!==legacyValue)mismatches.push(`totals.${key}`);
  }
  return{status:mismatches.length?'mismatch':'matched',mismatches,daily};
}
