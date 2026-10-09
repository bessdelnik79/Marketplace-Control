import {parseScale4Money,formatScale4Money} from '../overview/financial-overview.mjs';
import {calculateBuyout} from './sku-buyout.mjs';

// Presentation of persisted publication metrics, never another financial calculation.
export function buildSkuPresentation(model){
  const mismatch=model.reconciliation?.status==='mismatch';
  const amount=(item,key)=>item.metrics?.[key]?.amount??null;
  const items=model.items.map(item=>{
    const result=amount(item,'availableResultAfterTax'),revenue=amount(item,'revenue');
    const complete=!mismatch&&item.quality==='complete'&&item.metrics?.availableResultAfterTax?.availability==='complete'&&item.metrics?.revenue?.availability==='complete';
    let marginPercent=null,status='incomplete';
    if(complete&&result!==null&&revenue!==null){
      const r=parseScale4Money(result),v=parseScale4Money(revenue);
      if(v>0n){
        const magnitude=r<0n?-r:r,rounded=(magnitude*1000n+v/2n)/v;
        marginPercent=`${r<0n&&rounded!==0n?'-':''}${rounded/10n}.${rounded%10n}`;
      }
      status=r<0n?'loss':r===0n?'zero':v>0n&&r*100n<=v*5n?'near':'profit';
    }
    return {...item,status,marginPercent,buyout:calculateBuyout({sku:item.productId,periodEnd:model.context.period?.end,history:model.orderOutcomeHistories?.[item.productId]??model.orderOutcomeHistory})};
  });
  const sumMetric=key=>mismatch||!items.length||items.some(item=>amount(item,key)===null||item.metrics?.[key]?.availability!=='complete')?null:formatScale4Money(items.reduce((total,item)=>total+parseScale4Money(amount(item,key)),0n));
  const counts=Object.fromEntries(['loss','near','profit','incomplete','zero'].map(status=>[`${status}Count`,items.filter(item=>item.status===status).length]));
  return {items,summary:{skuResult:sumMetric('availableResultAfterTax'),revenue:sumMetric('revenue'),totalCount:items.length,...counts},quality:mismatch?'unavailable':model.context.quality};
}
