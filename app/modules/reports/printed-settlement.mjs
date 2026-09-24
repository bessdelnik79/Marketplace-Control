// The seller's printed form is a voluntary test oracle, never a calculation input.
function cents(value) {
  if(value === '—' || value === '–') return 0n;
  if(typeof value !== 'string') return null;
  const text=String(value).replace(/\s/g,'').replace(',','.');
  if(!/^\d+(?:\.\d{1,2})?$/.test(text))return null;
  const [whole,fraction='']=text.split('.');
  return BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
}

export function printedSellerSettlement(lines) {
  const values=Array.from({length:7},(_,index)=>cents(lines?.[index+1]));
  if(values.some(value=>value===null))return null;
  const [one,two,three,four,five,six,seven]=values;
  const amount=one-two-three+four+five-six-seven;
  return `${amount<0n?'-':''}${(amount<0n?-amount:amount)/100n}.${String((amount<0n?-amount:amount)%100n).padStart(2,'0')}`;
}
