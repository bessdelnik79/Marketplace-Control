import { formatScale4Money, parseScale4Money } from './financial-overview.mjs';

const severityRank={danger:0,warning:1};
const kindRank={product_loss:0,penalty:1,return_growth:2};

function absolute(value){return value<0n?-value:value;}
function unavailable(reason){
  return{status:'unavailable',missingReasons:[reason],evaluatedRules:[],disabledRules:['return_growth'],items:[],total:null};
}

export function buildSituations(financial,{limit=3}={}){
  if(limit!==null&&(!Number.isInteger(limit)||limit<1))throw new Error('situations_invalid_limit');
  if(!financial||financial.status!=='available'||financial.quality==='unavailable'||!financial.situationEvidence){
    return unavailable('financial_situation_inputs_unavailable');
  }
  const evidence=financial.situationEvidence,items=[];
  if(evidence.productLossEligible){
    const covered=new Set(financial.scope?.productIds??[]);
    for(const result of evidence.productResultsBeforeTax??[]){
      if(!covered.has(result.productId))continue;
      const amount=parseScale4Money(result.amount);
      if(amount<0n)items.push({
        id:`product_loss:${result.productId}`,kind:'product_loss',severity:'danger',productId:result.productId,
        metric:{code:'available_result_before_tax',value:formatScale4Money(amount),absoluteValue:formatScale4Money(absolute(amount)),unit:'RUB'},
        currentPeriod:financial.period,baselinePeriod:null,
        evidence:{type:'financial_publication',publicationId:financial.publicationId}
      });
    }
  }
  const penalty=parseScale4Money(evidence.penaltyAmount??'0.0000');
  if(penalty!==0n)items.push({
    id:'penalty',kind:'penalty',severity:'danger',productId:null,
    metric:{code:'penalty_net',value:formatScale4Money(penalty),absoluteValue:formatScale4Money(absolute(penalty)),unit:'RUB'},
    currentPeriod:financial.period,baselinePeriod:null,
    evidence:{type:'financial_publication',publicationId:financial.publicationId}
  });
  items.sort((left,right)=>{
    const fixed=severityRank[left.severity]-severityRank[right.severity]||kindRank[left.kind]-kindRank[right.kind];
    if(fixed)return fixed;
    const leftAmount=parseScale4Money(left.metric.absoluteValue),rightAmount=parseScale4Money(right.metric.absoluteValue);
    if(leftAmount!==rightAmount)return leftAmount>rightAmount?-1:1;
    return String(left.productId??'').localeCompare(String(right.productId??''))||left.id.localeCompare(right.id);
  });
  const missingReasons=['return_growth_rule_disabled',...(evidence.productLossEligible?[]:['product_loss_inputs_incomplete'])];
  return{
    status:missingReasons.length?'partial':'available',missingReasons,
    evaluatedRules:['product_loss','penalty'],disabledRules:['return_growth'],items:limit===null?items:items.slice(0,limit),total:items.length
  };
}
