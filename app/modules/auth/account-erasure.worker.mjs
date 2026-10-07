import { processAccountErasureCleanup } from './account-erasure.repository.mjs';
import { cleanupAccountSourceData } from '../../infrastructure/storage/account-erasure-storage.mjs';

export function createAccountErasureWorker({
  repository = { processAccountErasureCleanup }, cleanup = cleanupAccountSourceData,
  intervalMs = 60_000, logger = console
} = {}) {
  let timer, running;
  function runOnce() {
    if (running) return running;
    running = Promise.resolve().then(() => repository.processAccountErasureCleanup(cleanup))
      .finally(() => { running = null; });
    return running;
  }
  function tick() { runOnce().catch(() => logger.error('account_erasure_cleanup_failed')); }
  function start() {
    if (!timer) { timer = setInterval(tick, intervalMs); timer.unref?.(); tick(); }
  }
  async function stop() { clearInterval(timer); timer = null; await running; }
  return { runOnce, start, stop };
}
