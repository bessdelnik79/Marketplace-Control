const DAY = 86400000;
const MOSCOW_OFFSET = 3 * 60 * 60 * 1000;
const day = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value ? stamp : null;
};
const iso = (stamp) => new Date(stamp).toISOString().slice(0, 10);
const moscowDay = (value) => day(value) - MOSCOW_OFFSET;
const moscowDate = (stamp) => iso(stamp + MOSCOW_OFFSET);
const timestamp = (value) => {
  if (day(value) !== null) return moscowDay(value);
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || day(value.slice(0, 10)) === null) return null;
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) ? stamp : null;
};
const identity = (value) => typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

export function buyoutBounds(periodEnd) {
  const end = day(periodEnd);
  if (end === null) return null;
  const source = new Date(end);
  const year = source.getUTCFullYear() - 1;
  const month = source.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return { start: iso(Date.UTC(year, month, Math.min(source.getUTCDate(), lastDay))), cutoff: iso(end - 14 * DAY), end: periodEnd };
}

// Explicit order identities and confirmed outcomes only; financial totals cannot supply the denominator.
export function calculateBuyout({ sku, periodEnd, history } = {}) {
  const bounds = buyoutBounds(periodEnd);
  const unavailable = (reason) => ({ status: 'unavailable', reason, bounds, percent: null, sampleSize: 0 });
  if (!bounds || !identity(sku)) return unavailable('invalid_request');
  if (!history || !Array.isArray(history.records)) return unavailable('history_missing');
  const coverage = history.coverage;
  if (coverage?.complete !== true || day(coverage.start) === null || day(coverage.end) === null || coverage.start > bounds.cutoff || coverage.end < bounds.end) return unavailable('history_incomplete');
  const start = moscowDay(bounds.start);
  const cutoffEnd = moscowDay(bounds.cutoff) + DAY;
  const observationEnd = moscowDay(bounds.end) + DAY;
  const coverageStart = Math.max(start, moscowDay(coverage.start));
  const candidateIds = new Set();
  for (const record of history.records) {
    if (identity(record?.sku) !== sku.trim()) continue;
    const orderedAt = timestamp(record.orderedAt);
    if (orderedAt === null) return unavailable('invalid_record');
    const outcomeAt = timestamp(record.outcomeAt);
    if (orderedAt < coverageStart || orderedAt >= cutoffEnd || (outcomeAt !== null && outcomeAt >= observationEnd)) continue;
    const srid = identity(record.srid);
    if (!srid) return unavailable('invalid_record');
    candidateIds.add(srid);
  }
  const orders = new Map();
  for (const record of history.records) {
    const srid = identity(record?.srid);
    // Other SKUs and out-of-window orders cannot block this SKU, except identity collisions.
    if (!candidateIds.has(srid)) continue;
    const recordSku = identity(record.sku);
    const orderedAt = timestamp(record.orderedAt);
    const outcomeAt = timestamp(record.outcomeAt);
    if (!srid || !recordSku || orderedAt === null || outcomeAt === null || outcomeAt < orderedAt || !['retained', 'returned', 'refused', 'pending', 'unknown'].includes(record.outcome)) return unavailable('invalid_record');
    // Future outcomes must never rewrite an historical sample.
    if (orderedAt >= observationEnd || outcomeAt >= observationEnd) continue;
    const previous = orders.get(srid);
    if (previous && (previous.sku !== recordSku || previous.orderedAt !== orderedAt)) return unavailable('identity_conflict');
    const order = previous || { srid, sku: recordSku, orderedAt, outcomes: new Set(), retainedAt: [], returnedAt: [] };
    order.outcomes.add(record.outcome);
    if (record.outcome === 'retained') order.retainedAt.push(outcomeAt);
    if (record.outcome === 'returned') order.returnedAt.push(outcomeAt);
    orders.set(srid, order);
  }
  const eligible = [];
  for (const order of orders.values()) {
    if (order.sku !== sku.trim() || order.orderedAt < coverageStart || order.orderedAt >= cutoffEnd) continue;
    if (order.outcomes.has('refused') && (order.outcomes.has('retained') || order.outcomes.has('returned'))) return unavailable('outcome_conflict');
    if (order.retainedAt.length && order.returnedAt.length && Math.max(...order.retainedAt) > Math.min(...order.returnedAt)) return unavailable('outcome_conflict');
    const outcome = order.outcomes.has('returned') ? 'returned' : order.outcomes.has('retained') ? 'retained' : order.outcomes.has('refused') ? 'refused' : null;
    if (outcome) eligible.push({ ...order, outcome });
  }
  const sample = eligible.sort((a, b) => b.orderedAt - a.orderedAt || a.srid.localeCompare(b.srid)).slice(0, 100);
  if (sample.length < 100 && coverage.start > bounds.start) return unavailable('history_incomplete');
  if (!sample.length) return unavailable('no_confirmed_orders');
  const counts = { retained: 0, returned: 0, refused: 0 };
  sample.forEach((order) => { counts[order.outcome] += 1; });
  return { status: 'available', reason: null, bounds, percent: counts.retained / sample.length * 100, sampleSize: sample.length, counts, sampleStart: moscowDate(sample.at(-1).orderedAt), sampleEnd: moscowDate(sample[0].orderedAt), smallSample: sample.length < 30 };
}
