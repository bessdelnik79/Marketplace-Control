import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

const source=await readFile(new URL('./ui.js',import.meta.url),'utf8');
const start=source.indexOf('const rangeDayMs='),end=source.indexOf('const overviewStoreKey=',start);
assert.ok(start>=0&&end>start,'financial calendar helpers must precede overview storage');
const helpers=runInNewContext(`${source.slice(start,end)}\n({parseRangeDate,rangeIso,rangeWeekStart,rangePresetPeriod});`);
const date=value=>helpers.parseRangeDate(value);
const iso=value=>value?helpers.rangeIso(value):null;
const period=value=>value?{start:iso(value.start),end:iso(value.end)}:null;
const dayMs=86400000;
const fixedDate=instant=>class extends Date{
  constructor(...args){super(...(args.length?args:[instant]));}
};

test('financial presets end before the current week on every weekday, including Sunday',()=>{
  for(let day=5;day<=11;day++){
    const today=`2026-10-${String(day).padStart(2,'0')}`;
    assert.equal(iso(helpers.rangeWeekStart(date(today))),'2026-10-05',today);
    assert.deepEqual(period(helpers.rangePresetPeriod(date(today),7)),{start:'2026-09-28',end:'2026-10-04'},today);
  }
});

test('financial presets select one, two, four, thirteen and fifty-two complete weeks',()=>{
  const cases=[
    [7,'2026-09-28',7],
    [14,'2026-09-21',14],
    [30,'2026-09-07',28],
    [90,'2026-07-06',91],
    [365,'2025-10-06',364]
  ];
  for(const [length,start,days] of cases){
    const actual=helpers.rangePresetPeriod(date('2026-10-08'),length);
    assert.deepEqual(period(actual),{start,end:'2026-10-04'},String(length));
    assert.equal((actual.end-actual.start)/dayMs+1,days);
    assert.equal(actual.start.getUTCDay(),1);
    assert.equal(actual.end.getUTCDay(),0);
  }
});

test('closed-week presets cross month, leap-day and year boundaries exactly',()=>{
  const cases=[
    ['2026-01-01','2025-12-22','2025-12-28'],
    ['2025-01-06','2024-12-30','2025-01-05'],
    ['2024-03-04','2024-02-26','2024-03-03'],
    ['2024-03-03','2024-02-19','2024-02-25'],
    ['2026-10-01','2026-09-21','2026-09-27']
  ];
  for(const [today,start,end] of cases)assert.deepEqual(period(helpers.rangePresetPeriod(date(today),7)),{start,end},today);
});

test('operational presets retain exact calendar-day lengths ending today',()=>{
  for(const today of ['2026-10-08','2024-03-01','2026-01-01'])for(const length of [7,14,30,90,365]){
    const now=date(today),actual=helpers.rangePresetPeriod(now,length,true);
    assert.equal(iso(actual.end),today);
    assert.equal(actual.start.getTime(),now.getTime()-(length-1)*dayMs);
    assert.equal((actual.end-actual.start)/dayMs+1,length);
  }
});

test('calendar presets do not mutate the supplied dates',()=>{
  const start=date('2026-09-30'),end=date('2026-10-08'),today=date('2026-10-08');
  const before=[start.getTime(),end.getTime(),today.getTime()];
  helpers.rangeWeekStart(start);
  helpers.rangePresetPeriod(today,90);
  helpers.rangePresetPeriod(today,30,true);
  assert.deepEqual([start.getTime(),end.getTime(),today.getTime()],before);
});

test('actual financial picker quarter click submits thirteen closed weeks instead of ending today',()=>{
  const node=(extra={})=>({listeners:new Map(),value:'',disabled:false,textContent:'',
    addEventListener(name,handler){this.listeners.set(name,handler)},setAttribute(){},focus(){},...extra});
  let submitted=0;
  const picker=node({dataset:{rangeToday:'2026-10-08'},hasAttribute(){return false},requestSubmit(){submitted++}});
  const startValue=node({value:'2026-09-29'}),endValue=node({value:'2026-10-08'});
  const startText=node(),endText=node(),apply=node(),preset=node({dataset:{rangePreset:'90'}}),popover=node({hidden:true});
  const controls=new Map([
    ['[data-range-value="start"]',startValue],['[data-range-value="end"]',endValue],
    ['input[name="storeId"]',node({value:'store-1'})],['[data-range-trigger]',node()],
    ['[data-range-popover]',popover],['[data-range-days]',node()],['[data-range-month-label]',node()],
    ['[data-range-text="start"]',startText],['[data-range-text="end"]',endText],
    ['[data-range-hint]',node()],['[data-range-apply]',apply],['[data-range-reset]',node()],
    ['[data-range-label]',node()],['[data-range-month="next"]',node()]
  ]);
  const pickerStart=source.indexOf('function initializeRangePickers('),pickerEnd=source.indexOf('function startOperationalPanelUpdates(',pickerStart);
  assert.ok(pickerStart>=0&&pickerEnd>pickerStart);
  runInNewContext(`${source.slice(start,end)}\n${source.slice(pickerStart,pickerEnd)}\ninitializeRangePickers();`,{
    Date:fixedDate('2026-10-08T12:00:00Z'),AbortController,document:{body:{dataset:{storeId:'store-1'}},addEventListener(){}},
    $:selector=>controls.get(selector)??null,
    all:selector=>selector==='[data-range-picker]'?[picker]:selector==='[data-range-preset]'?[preset]:selector==='[data-range-popover]'?[popover]:[],
    saveOverviewPeriod(){},decorateOverviewLinks(){}
  });
  assert.equal(startText.value,'29.09.2026','initial manual start remains unchanged');
  assert.equal(endText.value,'08.10.2026','initial manual end remains unchanged');
  preset.listeners.get('click')();
  assert.equal(startText.value,'06.07.2026');
  assert.equal(endText.value,'04.10.2026');
  assert.equal(apply.disabled,false);
  controls.get('[data-range-reset]').listeners.get('click')();
  assert.equal(startText.value,'29.09.2026','reset restores the exact initial manual start');
  assert.equal(endText.value,'08.10.2026','reset restores the exact initial manual end');
  preset.listeners.get('click')();
  apply.listeners.get('click')();
  assert.equal(startValue.value,'2026-07-06');
  assert.equal(endValue.value,'2026-10-04');
  assert.equal(submitted,1);
});

test('financial today follows Moscow midnight even before the UTC date changes',()=>{
  for(const [instant,expected] of [['2026-10-04T20:59:59Z','2026-10-04'],['2026-10-04T21:00:00Z','2026-10-05'],['2026-10-04T21:30:00Z','2026-10-05']]){
    const local=runInNewContext(`${source.slice(start,end)}\n({rangeIso,rangeMoscowToday});`,{Date:fixedDate(instant)});
    assert.equal(local.rangeIso(local.rangeMoscowToday()),expected,instant);
  }
});
