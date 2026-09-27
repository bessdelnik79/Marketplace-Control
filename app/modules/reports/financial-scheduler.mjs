export function createFinancialScheduler({ pool, now = () => new Date() }) {
  if (!pool?.query) throw new TypeError('financial scheduler requires pool');

  async function scheduleDue({ limit = 100, at = now() } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new TypeError('limit must be an integer between 1 and 500');
    const instant = at instanceof Date ? at : new Date(at);
    if (Number.isNaN(instant.getTime())) throw new TypeError('at must be a valid timestamp');
    return (await pool.query('select * from mc.schedule_financial_inventory($1,$2)', [instant, limit])).rows;
  }

  return { scheduleDue };
}

export function startFinancialScheduler({ scheduleDue, intervalMs = 60000, onError = console.error } = {}) {
  if (typeof scheduleDue !== 'function') throw new TypeError('scheduleDue is required');
  if (!Number.isInteger(intervalMs) || intervalMs < 1000) throw new TypeError('intervalMs must be at least 1000');
  let active = false;
  const tick = async () => {
    if (active) return;
    active = true;
    try { await scheduleDue(); }
    catch (error) { onError(error); }
    finally { active = false; }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
