import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
const source=await readFile(new URL('./ui.js',import.meta.url),'utf8');
const selectionCode=source.slice(source.indexOf("  const selectionForm=$('[data-selection-form]');"),source.lastIndexOf('})();'));
function node(){const listeners=new Map();return{disabled:false,checked:false,attributes:new Map(),addEventListener(type,fn,options){const list=listeners.get(type)||[];list.push({fn,once:options?.once});listeners.set(type,list)},dispatch(type,event={}){for(const entry of [...listeners.get(type)||[]]){if(entry.once)listeners.set(type,listeners.get(type).filter(item=>item!==entry));entry.fn(event)}},setAttribute(k,v){this.attributes.set(k,v)},removeAttribute(k){this.attributes.delete(k)},focus(){this.focused=true}}}
function harness({checked=true,count=1,limit=3,base=0}={}){
 const form=node(),dialog=node(),accept=node(),cancel=node(),submit=node(),box=node(),counter=node(),selectAll=node();
 const boxes=Array.from({length:count},(_,i)=>i===0?box:node()),toasts=[];
 box.checked=checked;form.dataset={limit:String(limit),selectedCount:String(base),mode:'replace'};let sent=0,opens=0;
 const send=()=>{const event={preventDefault(){this.prevented=true}};form.dispatch('submit',event);if(!event.prevented)sent++};
 form.requestSubmit=button=>{assert.equal(button,submit);send()};
 dialog.close=value=>{dialog.open=false;dialog.returnValue=value??'';dialog.dispatch('close')};
 const lookup={'[data-selection-form]':form,'[data-select-all]':selectAll,'[data-selection-count]':counter,'[data-confirm-selection]':submit,'[data-selection-cancel]':cancel,'[data-selection-accept]':accept};
 runInNewContext(selectionCode,{$:s=>lookup[s]??null,all:s=>s==='input[name=productIds]'?boxes:[],dialog,toast(message){toasts.push(message)},openDialog(html){opens++;dialog.open=true;dialog.html=html},confirm(){assert.fail('native confirmation is forbidden')}});
 return{send,dialog,accept,cancel,submit,box,boxes,selectAll,counter,toasts,get sent(){return sent},get opens(){return opens}};
}
test('selection opens styled confirmation and submits exactly once only on acceptance',()=>{
 const h=harness();h.send();assert.equal(h.sent,0);assert.equal(h.opens,1);assert.match(h.dialog.html,/dialog-actions/);assert.equal(h.dialog.attributes.get('aria-labelledby'),'selection-confirm-title');
 h.accept.dispatch('click');assert.equal(h.sent,1);assert.equal(h.dialog.open,false);assert.equal(h.dialog.attributes.size,0);assert.equal(h.submit.focused,true);
});
test('cancel, Escape and close discard confirmation and a later attempt requires acceptance',()=>{
 for(const cancel of [h=>h.cancel.dispatch('click'),h=>h.dialog.close()]){const h=harness();h.send();cancel(h);assert.equal(h.sent,0);h.send();assert.equal(h.opens,2);assert.equal(h.sent,0);h.accept.dispatch('click');assert.equal(h.sent,1)}
});
test('repeat submit while confirmation is open never sends or duplicates the dialog',()=>{const h=harness();h.send();h.send();assert.equal(h.opens,1);assert.equal(h.sent,0);h.accept.dispatch('click');assert.equal(h.sent,1)});
test('empty product choice remains blocked before opening confirmation',()=>{const h=harness({checked:false});h.send();assert.equal(h.opens,0);assert.equal(h.sent,0);assert.equal(h.submit.disabled,true)});

test('select all checks products only and a second toggle clears them without submitting',()=>{
 const h=harness({checked:false,count:3});
 h.selectAll.checked=true;h.selectAll.dispatch('change');
 assert.deepEqual(h.boxes.map(b=>b.checked),[true,true,true]);assert.equal(h.counter.textContent,3);assert.equal(h.submit.disabled,false);assert.equal(h.selectAll.checked,true);assert.equal(h.sent,0);assert.equal(h.opens,0);
 h.selectAll.checked=false;h.selectAll.dispatch('change');
 assert.ok(h.boxes.every(b=>!b.checked&&!b.disabled));assert.equal(h.counter.textContent,0);assert.equal(h.submit.disabled,true);
});
test('select all preserves existing choices and respects remaining tariff capacity',()=>{
 const h=harness({count:5,limit:4,base:1});h.boxes[4].checked=true;h.boxes[4].dispatch('change');
 assert.equal(h.selectAll.indeterminate,true);
 h.selectAll.checked=true;h.selectAll.dispatch('change');
 assert.deepEqual(h.boxes.map(b=>b.checked),[true,true,false,false,true]);assert.equal(h.counter.textContent,4);assert.equal(h.selectAll.checked,true);assert.equal(h.selectAll.indeterminate,false);assert.equal(h.toasts.length,1);
 h.selectAll.checked=false;h.selectAll.dispatch('change');assert.equal(h.counter.textContent,1);assert.ok(h.boxes.every(b=>!b.checked));
});
