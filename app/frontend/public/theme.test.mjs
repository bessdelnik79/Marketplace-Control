import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';

const source=await readFile(new URL('./ui.js',import.meta.url),'utf8');
function section(start,end){
  const from=source.indexOf(start),to=source.indexOf(end,from);
  assert.ok(from>=0&&to>from,`Missing UI section: ${start}`);
  return source.slice(from,to);
}
const themeCode=section('  const $ =','  function toast(');
const accountCode=section("  const form=$('#account-form');","  const selectionForm=");

function fullScriptHarness({withMenu=false}={}){
  const classes=new Set(),listeners=new Map(),menu=node(),root={dataset:{}},choices=['light','dark','system'].map(themeChoice=>node({themeChoice}));
  const body={dataset:{},classList:{contains:value=>classes.has(value),remove:value=>classes.delete(value),toggle(value){if(classes.has(value)){classes.delete(value);return false}classes.add(value);return true}}};
  const document={body,documentElement:root,querySelector:selector=>selector==='[data-menu]'&&withMenu?menu:null,querySelectorAll:selector=>selector==='[data-theme-choice]'?choices:[],createElement:()=>({querySelectorAll:()=>[]}),addEventListener:(type,fn)=>listeners.set(type,fn)};
  runInContext(source,createContext({document,localStorage:{getItem:()=>null},matchMedia:()=>({matches:false,addEventListener(){}}),location:{pathname:'/onboarding/store',search:''}}));
  return{body,menu,root,choices,listeners};
}

test('entire UI script initializes on onboarding without menu dialog or account form',()=>{
  const h=fullScriptHarness();assert.equal(h.root.dataset.theme,'light');
  h.choices[1].dispatch('click');assert.equal(h.root.dataset.theme,'dark');
  h.listeners.get('keydown')({key:'Escape'});assert.equal(h.body.classList.contains('menu-open'),false);
});

test('mobile menu keeps expanded state in sync after click Escape and outside click',()=>{
  const h=fullScriptHarness({withMenu:true});
  h.menu.dispatch('click');assert.equal(h.body.classList.contains('menu-open'),true);assert.equal(h.menu.attributes.get('aria-expanded'),'true');
  h.listeners.get('keydown')({key:'Escape'});assert.equal(h.body.classList.contains('menu-open'),false);assert.equal(h.menu.attributes.get('aria-expanded'),'false');
  h.menu.dispatch('click');h.listeners.get('click')({target:{closest:()=>null}});assert.equal(h.body.classList.contains('menu-open'),false);assert.equal(h.menu.attributes.get('aria-expanded'),'false');
});

function node(dataset={}){
  const listeners=new Map(),classes=new Set();
  return{dataset,attributes:new Map(),value:'',validationMessage:'',reports:0,
    classList:{contains:name=>classes.has(name),toggle(name,force){const active=force??!classes.has(name);if(active)classes.add(name);else classes.delete(name);return active}},
    addEventListener(type,listener){const list=listeners.get(type)||[];list.push(listener);listeners.set(type,list)},
    dispatch(type){const event={target:this,defaultPrevented:false,preventDefault(){this.defaultPrevented=true}};for(const listener of listeners.get(type)||[])listener(event);return event},
    setAttribute(name,value){this.attributes.set(name,String(value))},
    setCustomValidity(message){this.validationMessage=message},
    reportValidity(){this.reports++;return !this.validationMessage},
  };
}

function harness({savedTheme=null,dark=false,account=false,storageUnavailable=false}={}){
  const values=new Map(),choices=['light','dark','system'].map(themeChoice=>node({themeChoice})),mediaListeners=[];
  if(savedTheme!==null)values.set('mc-theme',savedTheme);
  values.set('mc-profile:owner','legacy profile');
  const form=node(),displayName=node(),reset=node(),logout=node(),root=node(),body=node({account:'owner'}),createdForms=[],messages=[];
  displayName.value='Alice';form.elements={displayName};body.append=element=>createdForms.push(element);
  const lookup={'#account-form':account?form:null,'[data-reset-settings]':reset,'[data-logout]':logout};
  const media={matches:dark,addEventListener(type,listener){assert.equal(type,'change');mediaListeners.push(listener)}};
  const document={body,documentElement:root,querySelector:selector=>lookup[selector]??null,querySelectorAll:selector=>selector==='[data-theme-choice]'?choices:[],createElement(tag){assert.equal(tag,'form');const element={submitted:0,submit(){this.submitted++}};return element}};
  const localStorage={getItem(key){if(storageUnavailable)throw new Error('storage disabled');return values.get(key)??null},setItem(key,value){if(storageUnavailable)throw new Error('storage disabled');values.set(key,String(value))},removeItem(key){if(storageUnavailable)throw new Error('storage disabled');values.delete(key)}};
  const context=createContext({document,localStorage,matchMedia(query){assert.equal(query,'(prefers-color-scheme: dark)');return media},toast:message=>messages.push(message)});
  runInContext(themeCode,context);
  runInContext(accountCode,context);
  return{values,choices,root,form,displayName,reset,logout,createdForms,messages,
    choose(value){const button=choices.find(choice=>choice.dataset.themeChoice===value);assert.ok(button);button.dispatch('click')},
    changeSystem(value){media.matches=value;for(const listener of mediaListeners)listener({matches:value})},
  };
}

function assertTheme(h,choice,resolved){
  assert.equal(h.root.dataset.theme,resolved);
  for(const button of h.choices){const selected=button.dataset.themeChoice===choice;assert.equal(button.classList.contains('selected'),selected);assert.equal(button.attributes.get('aria-pressed'),String(selected))}
}

test('system theme follows OS at startup and on changes without persisting a forced theme',()=>{
  for(const dark of [false,true])for(const savedTheme of [null,'system']){
    const h=harness({dark,savedTheme});assertTheme(h,'system',dark?'dark':'light');
    h.changeSystem(!dark);assertTheme(h,'system',dark?'light':'dark');
    assert.equal(h.values.get('mc-theme'),savedTheme??undefined);
  }
});

test('explicit light and dark themes override OS on startup and later OS changes',()=>{
  for(const savedTheme of ['light','dark'])for(const dark of [false,true]){
    const h=harness({savedTheme,dark});assertTheme(h,savedTheme,savedTheme);
    h.changeSystem(!dark);assertTheme(h,savedTheme,savedTheme);
  }
});

test('header choice persists all three modes and system mode resumes OS tracking',()=>{
  const h=harness();
  for(const choice of ['dark','light','system']){
    h.choose(choice);assert.equal(h.values.get('mc-theme'),choice);
    assertTheme(h,choice,choice==='system'?'light':choice);
    const reloaded=harness({savedTheme:h.values.get('mc-theme')});assertTheme(reloaded,choice,choice==='system'?'light':choice);
  }
  h.changeSystem(true);assertTheme(h,'system','dark');assert.equal(h.values.get('mc-theme'),'system');
});

test('invalid stored theme falls back to system and continues following OS',()=>{
  for(const savedTheme of ['sepia','DARK','null'])for(const dark of [false,true]){
    const h=harness({savedTheme,dark});assertTheme(h,'system',dark?'dark':'light');
    h.changeSystem(!dark);assertTheme(h,'system',dark?'light':'dark');
  }
});

test('blocked local storage does not prevent theme selection or account initialization',()=>{
  const h=harness({dark:true,account:true,storageUnavailable:true});assertTheme(h,'system','dark');
  h.choose('light');assertTheme(h,'light','light');h.choose('system');h.changeSystem(false);assertTheme(h,'system','light');
});

test('cancel restores only name and validation while preserving the current header theme',()=>{
  const h=harness({account:true,savedTheme:'light'});
  h.displayName.value='x';assert.equal(h.form.dispatch('submit').defaultPrevented,true);
  h.choose('dark');h.reset.dispatch('click');
  assert.equal(h.displayName.value,'Alice');assert.equal(h.displayName.validationMessage,'');
  assertTheme(h,'dark','dark');assert.equal(h.values.get('mc-theme'),'dark');assert.equal(h.messages.length,1);
});

test('cancel leaves a newly selected system mode responsive to OS changes',()=>{
  const h=harness({account:true,savedTheme:'dark'});h.displayName.value='Changed';h.choose('system');h.reset.dispatch('click');
  assert.equal(h.displayName.value,'Alice');assertTheme(h,'system','light');
  h.changeSystem(true);assertTheme(h,'system','dark');assert.equal(h.values.get('mc-theme'),'system');
});

test('account submit blocks names shorter than two trimmed characters and allows valid names',()=>{
  const h=harness({account:true});
  for(const name of ['','  ',' x ']){h.displayName.value=name;assert.equal(h.form.dispatch('submit').defaultPrevented,true);assert.ok(h.displayName.validationMessage)}
  assert.equal(h.displayName.reports,3);
  h.displayName.value='  Al  ';assert.equal(h.form.dispatch('submit').defaultPrevented,false);assert.equal(h.displayName.validationMessage,'');
});

test('name input clears previous validation without changing theme',()=>{
  const h=harness({account:true,savedTheme:'dark'});h.displayName.value='x';h.form.dispatch('submit');assert.ok(h.displayName.validationMessage);
  h.displayName.value='Alice';h.displayName.dispatch('input');assert.equal(h.displayName.validationMessage,'');assertTheme(h,'dark','dark');
});

test('account initialization clears legacy local profile and logout submits a POST form',()=>{
  const h=harness({account:true,savedTheme:'dark'});assert.equal(h.values.has('mc-profile:owner'),false);assert.equal(h.values.get('mc-theme'),'dark');
  h.logout.dispatch('click');assert.equal(h.createdForms.length,1);
  const [form]=h.createdForms;assert.equal(form.method,'post');assert.equal(form.action,'/logout');assert.equal(form.submitted,1);
});
