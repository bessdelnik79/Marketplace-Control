export function scaledMoneyMatches(left,right,scale){
  if(typeof left!=='bigint'||typeof right!=='bigint')throw new TypeError('money_comparison_bigint_required');
  if(!Number.isSafeInteger(scale)||scale<3)throw new RangeError('money_comparison_invalid_scale');
  const difference=left-right,absolute=difference<0n?-difference:difference;
  return absolute<=5n*10n**BigInt(scale-3);
}
