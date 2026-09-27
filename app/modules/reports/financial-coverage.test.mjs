import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { annualFinancialWeeks, moscowDate, weeklyFinancialWindow } from './financial-coverage.mjs';

const fixture = JSON.parse(await readFile(new URL('../../../db/tests/fixtures/financial-event-contract.json', import.meta.url), 'utf8'));

test('annual credential window contains the expected 53 closed Moscow weeks', () => {
  const result = annualFinancialWeeks(fixture.credentialYear.eventLocal);
  assert.equal(result.lookbackDate, fixture.credentialYear.lookbackDate);
  assert.equal(result.lastClosedSunday, fixture.credentialYear.lastClosedSunday);
  assert.equal(result.weeks.length, fixture.credentialYear.weekCount);
  assert.deepEqual(result.weeks[0], { weekStart: fixture.credentialYear.firstWeek.start, weekEnd: fixture.credentialYear.firstWeek.end });
  assert.deepEqual(result.weeks.at(-1), { weekStart: fixture.credentialYear.lastWeek.start, weekEnd: fixture.credentialYear.lastWeek.end });
});

test('Moscow calendar boundary changes at 21:00 UTC on Sunday', () => {
  assert.equal(moscowDate('2026-09-27T20:59:59Z'), '2026-09-27');
  assert.equal(moscowDate('2026-09-27T21:00:00Z'), '2026-09-28');
  assert.deepEqual(weeklyFinancialWindow('2026-09-27T21:00:00Z').dueWeek, { weekStart: '2026-09-21', weekEnd: '2026-09-27' });
});

test('weekly scheduler builds one five-week freshness window and catches up after restart', () => {
  const result = weeklyFinancialWindow('2026-10-04T21:05:00Z');
  assert.equal(result.scheduleBoundary, '2026-10-05');
  assert.deepEqual(result.dueWeek, { weekStart: '2026-09-28', weekEnd: '2026-10-04' });
  assert.deepEqual(result.window, { dateFrom: '2026-08-31', dateTo: '2026-10-04' });
});

test('annual window handles leap-day lookback and excludes open week', () => {
  const result = annualFinancialWeeks('2024-02-29T12:00:00+03:00');
  assert.equal(result.lookbackDate, '2023-02-28');
  assert.equal(result.lastClosedSunday, '2024-02-25');
  assert.deepEqual(result.weeks.at(-1), { weekStart: '2024-02-19', weekEnd: '2024-02-25' });
});
