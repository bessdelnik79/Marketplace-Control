import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const fixture = JSON.parse(await readFile(
  new URL('../../../db/tests/fixtures/financial-event-contract.json', import.meta.url),
  'utf8'
));

function date(value) {
  return new Date(`${value}T00:00:00Z`);
}

test('credential-year fixture covers 53 complete intersecting Moscow weeks', () => {
  const { credentialYear } = fixture;
  const milliseconds = date(credentialYear.lastWeek.start) - date(credentialYear.firstWeek.start);
  assert.equal(milliseconds / (7 * 86400000) + 1, credentialYear.weekCount);
  assert.ok(date(credentialYear.firstWeek.start) <= date(credentialYear.lookbackDate));
  assert.ok(date(credentialYear.firstWeek.end) >= date(credentialYear.lookbackDate));
  assert.equal(credentialYear.lastWeek.end, credentialYear.lastClosedSunday);
});

test('weekly fixture changes only at Monday midnight Moscow and preserves catch-up week', () => {
  assert.equal(fixture.timezone, 'Europe/Moscow');
  assert.equal(fixture.weeklySchedule[0].dueWeek, null);
  assert.deepEqual(fixture.weeklySchedule[1].dueWeek, { start: '2026-09-21', end: '2026-09-27' });
  assert.equal(fixture.weeklySchedule[2].reason, 'restart_catch_up');
});

test('coverage and local invalidation fixtures fail closed without unnecessary WB calls', () => {
  const empty = fixture.coverage.find(item => item.case === 'empty_detail_before_inventory_confirmation');
  assert.equal(empty.coverageState, 'pending');
  assert.equal(empty.retryable, true);
  assert.ok(fixture.events.every(event => event.allowsWbApi === false));
  assert.deepEqual(fixture.events.find(event => event.type === 'cost_changed').affectedPeriod, {
    start: '2026-09-10', end: '2026-09-19'
  });
});
