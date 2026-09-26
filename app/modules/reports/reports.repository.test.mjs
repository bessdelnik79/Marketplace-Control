import test from 'node:test';
import assert from 'node:assert/strict';
import { selectHistoricalRenormalizationWeek } from './reports.repository.mjs';

const ranges={
  initialRange:{dateFrom:'2026-06-01',dateTo:'2026-09-25'},
  recentRange:{dateFrom:'2026-09-21',dateTo:'2026-09-25'}
};

test('historical renormalization selects the latest complete old week',()=>{
  assert.deepEqual(selectHistoricalRenormalizationWeek([
    {date_from:'2026-09-14',date_to:'2026-09-20'},
    {date_from:'2026-08-10',date_to:'2026-08-16'},
    {date_from:'2026-08-17',date_to:'2026-08-23'}
  ],ranges),{dateFrom:'2026-09-14',dateTo:'2026-09-20'});
});

test('historical renormalization repairs the complete week overlapping recent start',()=>{
  assert.deepEqual(selectHistoricalRenormalizationWeek([
    {date_from:'2026-08-10',date_to:'2026-08-16'},
    {date_from:'2026-08-17',date_to:'2026-08-23'}
  ],{
    initialRange:{dateFrom:'2026-06-27',dateTo:'2026-09-26'},
    recentRange:{dateFrom:'2026-08-22',dateTo:'2026-09-26'}
  }),{dateFrom:'2026-08-17',dateTo:'2026-08-23'});
});

test('historical renormalization excludes recent, partial and out-of-range periods',()=>{
  assert.equal(selectHistoricalRenormalizationWeek([
    {date_from:'2026-09-21',date_to:'2026-09-25'},
    {date_from:'2026-09-15',date_to:'2026-09-20'},
    {date_from:'2026-05-25',date_to:'2026-05-31'},
    {date_from:'2026-09-14',date_to:'2026-09-21'}
  ],ranges),null);
});

test('historical renormalization requires explicit initial and recent bounds',()=>{
  const candidates=[{date_from:'2026-08-10',date_to:'2026-08-16'}];
  assert.equal(selectHistoricalRenormalizationWeek(candidates,{initialRange:ranges.initialRange}),null);
  assert.equal(selectHistoricalRenormalizationWeek(candidates,{recentRange:ranges.recentRange}),null);
});
