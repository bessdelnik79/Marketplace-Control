import test from 'node:test';
import assert from 'node:assert/strict';
import {scaledMoneyMatches} from './money-comparison.mjs';

test('money comparison accepts inclusive half-kopeck differences at every supported scale',()=>{
  for(const scale of [3,4,12,30,31]){
    const unit=10n**BigInt(scale),halfKopeck=5n*10n**BigInt(scale-3);
    for(const sign of [-1n,1n]){
      assert.equal(scaledMoneyMatches(unit+sign*halfKopeck,unit,scale),true);
      assert.equal(scaledMoneyMatches(unit+sign*(halfKopeck+1n),unit,scale),false);
      assert.equal(scaledMoneyMatches(-unit+sign*halfKopeck,-unit,scale),true);
    }
  }
  assert.throws(()=>scaledMoneyMatches(1,1n,4),TypeError);
  for(const scale of [2,3.5,NaN,Infinity])assert.throws(()=>scaledMoneyMatches(1n,1n,scale),RangeError);
  assert.equal(scaledMoneyMatches(999999999999999999999005n,999999999999999999999000n,3),true);
  assert.equal(scaledMoneyMatches(999999999999999999999006n,999999999999999999999000n,3),false);
});
