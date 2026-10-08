import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';

const source=await readFile(new URL('./ui.js',import.meta.url),'utf8');
const controls=source.slice(source.indexOf("  all('[data-password-toggle]')"),source.lastIndexOf('})();'));
function element(initial={}){
  const listeners=new Map(),attributes=new Map();
  return {...initial,addEventListener(event,listener){listeners.set(event,listener)},dispatch(event){listeners.get(event)?.()},setAttribute(key,value){attributes.set(key,value)},getAttribute(key){return attributes.get(key)},attributes};
}
function setup({withPassword=true,current='free',chosen='free'}={}){
  const password=element({type:'password'}),toggle=element({dataset:{passwordToggle:'password'}});
  toggle.setAttribute('aria-label','Показать: новый пароль');
  const tariff=element({dataset:{savedPlan:current}}),radio=element({value:chosen,disabled:false}),tariffSave=element();
  const erasure=element(),confirmation=element({value:''}),currentPassword=withPassword?element({value:''}):null,deleteSave=element();
  const lookup=new Map([[tariff,new Map([['input[name="plan"]:checked',radio],['button[type="submit"]',tariffSave]])],[erasure,new Map([['[name="confirmation"]',confirmation],['[name="currentPassword"]',currentPassword],['button[type="submit"]',deleteSave]])]]);
  runInContext(controls,createContext({all:()=>[toggle],document:{getElementById:()=>password},$:(selector,root)=>root?lookup.get(root)?.get(selector):selector==='[data-tariff-form]'?tariff:selector==='[data-erasure-form]'?erasure:null}));
  return {password,toggle,tariff,radio,tariffSave,erasure,confirmation,currentPassword,deleteSave};
}
test('password visibility changes only input type and accessible state',()=>{
  const h=setup();h.toggle.dispatch('click');assert.equal(h.password.type,'text');assert.equal(h.toggle.attributes.get('aria-pressed'),'true');assert.equal(h.toggle.attributes.get('aria-label'),'Скрыть: новый пароль');
  h.toggle.dispatch('click');assert.equal(h.password.type,'password');assert.equal(h.toggle.attributes.get('aria-pressed'),'false');
});
test('tariff save requires a different enabled plan but never grants access',()=>{
  const h=setup();assert.equal(h.tariffSave.disabled,true);h.radio.value='minimal';h.tariff.dispatch('change');assert.equal(h.tariffSave.disabled,false);h.radio.disabled=true;h.tariff.dispatch('change');assert.equal(h.tariffSave.disabled,true);
});
test('deletion is disabled until exact confirmation and a present password field is filled',()=>{
  const h=setup();assert.equal(h.deleteSave.disabled,true);h.confirmation.value='УДАЛИТЬ';h.erasure.dispatch('input');assert.equal(h.deleteSave.disabled,true);h.currentPassword.value='entered';h.erasure.dispatch('input');assert.equal(h.deleteSave.disabled,false);h.confirmation.value='удалить';h.erasure.dispatch('input');assert.equal(h.deleteSave.disabled,true);
});
test('OAuth deletion needs confirmation without introducing a password requirement',()=>{
  const h=setup({withPassword:false});h.confirmation.value='УДАЛИТЬ';h.erasure.dispatch('input');assert.equal(h.deleteSave.disabled,false);
});
test('returning to the effective tariff can replace a different saved paid request',()=>{
  const h=setup({current:'plus',chosen:'plus'});assert.equal(h.tariffSave.disabled,true);h.radio.value='minimal';h.tariff.dispatch('change');assert.equal(h.tariffSave.disabled,false);
});
