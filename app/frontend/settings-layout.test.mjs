import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';
import {financialMetadata} from './settings-layout.mjs';
import {financialSyncView,settingsDataPage,tariffPage,passwordPage,taxesPage,expensesPage,productsPage,accountErasurePage} from './pages.mjs';

test('reference return button is applied to six requested pages and their locked states',()=>{
  const owner={id:'owner'},stores=[{id:'store',connected:true}],renderers=[expensesPage,taxesPage,settingsDataPage,tariffPage,passwordPage,productsPage];
  for(const render of renderers){const html=render(owner,stores);assert.match(html,/class="outline-button settings-back reference-back" href="\/settings\?storeId=store"><svg[^>]*aria-hidden="true"/);assert.match(html,/<\/svg>Вернуться в личный кабинет<\/a>/);}
  for(const render of [productsPage,expensesPage])assert.match(render(owner,[]),/class="back-link reference-back"/);
  assert.doesNotMatch(accountErasurePage(owner,{stores,csrf:'test'}),/reference-back/);
});

test('financial metadata keeps absent counts unavailable and preserves confirmed zeroes',()=>{
  assert.equal(financialMetadata({}).checked,'— из —');assert.equal(financialMetadata({}).reports,'—');
  const value=financialMetadata({complete_weeks:0,empty_weeks:0,absent_weeks:0,total_weeks:0,report_count:0,issue_count:0});
  assert.equal(value.checked,'0 из 0');assert.equal(value.reports,'0');assert.equal(value.issues,'0');
});
test('financial status JSON and rendered table share the same persisted metadata',()=>{
  const store={id:'store',connected:true},financial={run_status:'running',complete_weeks:44,empty_weeks:0,absent_weeks:0,total_weeks:53,report_count:50,coverage_to:'2026-10-04'};
  assert.equal(financialSyncView(financial,store).metadata.checked,'44 из 53');
  const html=settingsDataPage({id:'owner'},[store],{financial});assert.match(html,/data-financial-sync-meta="checked">44 из 53/);assert.match(html,/data-financial-sync-meta="reports">50/);
});
test('compact API status avoids duplicate table counts and preserves failures',()=>{
  const store={id:'store',connected:true},financial={last_success_at:'2026-10-07',coverage_to:'2026-10-04',total_weeks:52,complete_weeks:45,absent_weeks:7};
  const view=financialSyncView(financial,store);
  assert.doesNotMatch(view.compactNote,/Проверено недель|отчётов:/);
  assert.match(view.compactNote,/Покрытие проверено/);
  assert.match(financialSyncView({...financial,run_status:'failed',error_code:'financial_unauthorized'},store).compactNote,/Токен/);
  assert.match(settingsDataPage({id:'owner'},[store],{financial}),/data-financial-sync-compact/);
});
test('poll completion updates metadata cells along with title note and button',async()=>{
  const source=await readFile(new URL('./public/ui.js',import.meta.url),'utf8');
  const from=source.indexOf('    const update=state=>'),to=source.indexOf('    const showPollError=',from);
  const cells=['checked','reports','coverage','updated'].map(key=>({dataset:{financialSyncMeta:key},textContent:'old'}));
  const fields=new Map(['title','note','button'].map(key=>[`[data-financial-sync-${key}]`,{}]));
  const removed=[],panel={classList:{toggle(){}},setAttribute(){},removeAttribute(name){removed.push(name)}};
  const state={title:'Готово',note:'Свежая сводка',buttonLabel:'Обновить отчёты',buttonDisabled:false,running:false,busy:false,metadata:{checked:'53 из 53',reports:'64',coverage:'04.10.2026',updated:'Обновлено'}};
  runInContext(source.slice(from,to)+'update(state);',createContext({$:(selector)=>fields.get(selector),all:()=>cells,financialSync:panel,state}));
  assert.deepEqual(cells.map(cell=>cell.textContent),['53 из 53','64','04.10.2026','Обновлено']);assert.ok(removed.includes('data-financial-sync-refresh'));assert.equal(fields.get('[data-financial-sync-button]').disabled,false);
});
test('tariff renderer compares selection to saved request and preserves effective current plan',()=>{
  const plans=[{code:'minimal',name:'Минимальный',product_limit:10,store_limit:1,price:null},{code:'plus',name:'Плюс',product_limit:100,store_limit:2,price:null}];
  const html=tariffPage({id:'owner'},[],{current:plans[0],plans,requestedCode:'plus'});
  assert.match(html,/data-saved-plan="plus"/);assert.match(html,/value="plus" checked/);assert.match(html,/Сейчас: <strong>Минимальный/);
});
test('security subpages retain active settings navigation and keyboard-operable reveal controls',()=>{
  const html=passwordPage({id:'owner'},[{id:'store',connected:true}]);
  assert.match(html,/href="\/settings\?storeId=store" class="nav-link active" aria-current="page"/);
  assert.equal([...html.matchAll(/type="button" data-password-toggle=/g)].length,3);
  assert.match(html,/class="outline-button" href="\/settings\?storeId=store">Отменить/);
});
test('tax history exposes labels for stacked mobile rows without changing versioned state',()=>{
  const html=taxesPage({id:'owner'},[],{history:[{effective_from:'2026-09-01',regime_code:'usn_income',usn_rate_fraction:'0.06',vat_mode:'exempt',state:'active'}]});
  assert.match(html,/tax-cell-label">Действует с<\/span>01\.09\.2026/);assert.match(html,/tax-cell-label">Статус<\/span>Действует/);
});
