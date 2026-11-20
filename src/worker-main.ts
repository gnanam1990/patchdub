import { openDb } from './db.ts';
import { LocalSellerAdapter } from './provider.ts';
import { runWorkerTick, sweepInFlight } from './worker.ts';

const db = openDb();
const adapter = new LocalSellerAdapter(db, {
  settle: (process.env.PATCHDUB_SETTLE as 'auto' | 'manual' | 'unresolvable') ?? 'auto',
});
const intervalMs = Number(process.env.PATCHDUB_WORKER_INTERVAL_MS ?? 500);

// Crash recovery before processing new work.
const requeued = sweepInFlight(db);
if (requeued > 0) console.log(`worker: requeued ${requeued} in-flight purchase verification(s)`);

console.log(`patchdub worker running (interval ${intervalMs}ms, rail ${adapter.rail})`);
const timer = setInterval(() => {
  try {
    const { processed } = runWorkerTick(db, adapter);
    if (processed > 0) console.log(`worker: processed ${processed} job(s)`);
  } catch (err) {
    console.error('worker tick failed:', err);
  }
}, intervalMs);

process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
