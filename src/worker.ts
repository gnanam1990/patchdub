import { id, now, variantDigest } from './util/hash.ts';
import { tx, type DB } from './db.ts';
import { runChecksForPatch } from './checks.ts';
import type { SellerAdapter } from './provider.ts';

export interface WorkerOptions {
  kinds?: string[];          // limit job kinds (used by tests to pause mid-flow)
  limit?: number;            // max jobs per tick
  maxAttempts?: number;      // attempts before a stuck verify marks the purchase unknown
}

interface OutboxRow {
  id: string; workspace_id: string; kind: string; payload: string; attempts: number;
}

/**
 * Process pending outbox jobs once. Dispatch and settlement verification are
 * separate durable steps so a crash between "provider accepted" and "receipt
 * observed" is recoverable without a second purchase (INV-07).
 */
export function runWorkerTick(db: DB, adapter: SellerAdapter, opts?: WorkerOptions): { processed: number } {
  const kinds = opts?.kinds ?? ['dispatch_order', 'verify_order'];
  const limit = opts?.limit ?? 25;
  const maxAttempts = opts?.maxAttempts ?? 50;
  const jobs = db.prepare(
    `SELECT * FROM outbox WHERE status = 'pending' AND kind IN (${kinds.map(() => '?').join(',')})
     ORDER BY created_at LIMIT ?`,
  ).all(...kinds, limit) as OutboxRow[];

  let processed = 0;
  for (const job of jobs) {
    const payload = JSON.parse(job.payload) as { purchaseId: string };
    try {
      if (job.kind === 'dispatch_order') dispatchOrder(db, adapter, payload.purchaseId);
      else if (job.kind === 'verify_order') verifyOrder(db, adapter, payload.purchaseId, job.attempts, maxAttempts);
      db.prepare("UPDATE outbox SET status = 'done', processed_at = ? WHERE id = ?").run(now(), job.id);
      processed++;
    } catch (err) {
      db.prepare('UPDATE outbox SET attempts = attempts + 1 WHERE id = ?').run(job.id);
      console.error(`outbox ${job.kind} ${job.id} failed:`, err);
    }
  }
  return { processed };
}

function dispatchOrder(db: DB, adapter: SellerAdapter, purchaseId: string): void {
  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchaseId) as
    Record<string, unknown> | undefined;
  if (!purchase) return;
  if (purchase.status !== 'reserved') return; // already dispatched or resolved
  const patch = db.prepare('SELECT * FROM patches WHERE id = ?').get(purchase.patch_id as string) as
    Record<string, unknown>;
  const plan = db.prepare('SELECT * FROM repair_plans WHERE id = ?').get(purchase.plan_id as string) as
    Record<string, unknown>;
  const edition = db.prepare('SELECT target_locale FROM editions WHERE id = ?').get(plan.edition_id as string) as
    { target_locale: string };

  const { externalRef } = adapter.execute({
    orderKey: purchase.order_key as string,
    purchaseId,
    items: [{
      patchId: patch.id as string,
      orderKey: purchase.order_key as string,
      sourceText: patch.source_text as string,
      context: JSON.parse(patch.context as string).map((c: { text: string }) => c.text),
      targetLocale: edition.target_locale,
      glossaryDigest: patch.glossary_digest as string | null,
    }],
    quoteMinor: purchase.quote_minor as number,
    token: purchase.token as string,
    decimals: purchase.decimals as number,
    idempotencyKey: purchase.idempotency_key as string,
  });

  tx(db, () => {
    db.prepare("UPDATE purchases SET status = 'dispatched', external_ref = ?, updated_at = ? WHERE id = ?")
      .run(externalRef, now(), purchaseId);
    db.prepare("UPDATE patches SET status = 'dispatched', updated_at = ? WHERE id = ?")
      .run(now(), patch.id as string);
    db.prepare('INSERT INTO outbox(id,workspace_id,operation_id,kind,payload,status,attempts,created_at) VALUES (?,?,?,?,?,?,0,?)')
      .run(id('obx'), purchase.workspace_id as string, null, 'verify_order',
        JSON.stringify({ purchaseId }), 'pending', now());
  });
}

export function verifyOrder(
  db: DB, adapter: SellerAdapter, purchaseId: string, attempts = 0, maxAttempts = 50,
): void {
  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchaseId) as
    Record<string, unknown> | undefined;
  if (!purchase || !purchase.external_ref) return;
  if (!['dispatched', 'unknown'].includes(purchase.status as string)) return;

  const status = adapter.status(purchase.external_ref as string);
  if (status.state === 'pending') {
    if (attempts + 1 >= maxAttempts) {
      // Provider cannot establish outcome: pending-reconciliation, no redispatch.
      markUnknown(db, purchaseId);
      db.prepare("UPDATE outbox SET status = 'done', processed_at = ? WHERE kind = 'verify_order' AND payload LIKE ? AND status = 'pending'")
        .run(now(), `%"${purchaseId}"%`);
    }
    throw new Error('provider still pending'); // retry on next tick
  }
  if (status.state === 'unknown' || status.state === 'failed') {
    markUnknown(db, purchaseId);
    return;
  }
  applySettledResult(db, purchaseId, status.receipt ?? {}, status.results ?? {}, 'settled');
}

export function markUnknown(db: DB, purchaseId: string): void {
  tx(db, () => {
    db.prepare("UPDATE purchases SET status = 'unknown', updated_at = ? WHERE id = ?").run(now(), purchaseId);
    const p = db.prepare('SELECT patch_id FROM purchases WHERE id = ?').get(purchaseId) as { patch_id: string };
    db.prepare("UPDATE patches SET status = 'flagged', updated_at = ? WHERE id = ? AND status != 'approved'")
      .run(now(), p.patch_id);
  });
}

/** Attach the independently observed receipt and apply translated variants. */
export function applySettledResult(
  db: DB, purchaseId: string, receipt: Record<string, unknown>,
  results: Record<string, string>, newStatus: 'settled' | 'reconciled',
): void {
  tx(db, () => {
    const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchaseId) as
      Record<string, unknown>;
    db.prepare('UPDATE purchases SET status = ?, amount_minor = ?, receipt = ?, updated_at = ? WHERE id = ?')
      .run(newStatus, receipt.amountMinor ?? purchase.quote_minor, JSON.stringify(receipt), now(), purchaseId);
    for (const [patchId, text] of Object.entries(results)) {
      db.prepare(`UPDATE patches SET variant_text = ?, variant_hash = ?, status = 'translated',
        expected_version = expected_version + 1, updated_at = ? WHERE id = ? AND status != 'approved'`)
        .run(text, variantDigest(text), now(), patchId);
      runChecksForPatch(db, patchId);
    }
  });
}

/**
 * Crash recovery: purchases dispatched but never verified get a fresh verify
 * job keyed to the ORIGINAL external reference — never a second execute.
 */
export function sweepInFlight(db: DB): number {
  const stuck = db.prepare(`
    SELECT p.id, p.workspace_id FROM purchases p
    WHERE p.status = 'dispatched'
      AND NOT EXISTS (
        SELECT 1 FROM outbox o
        WHERE o.kind = 'verify_order' AND o.status = 'pending' AND o.payload LIKE '%' || p.id || '%'
      )`).all() as { id: string; workspace_id: string }[];
  for (const s of stuck) {
    db.prepare('INSERT INTO outbox(id,workspace_id,operation_id,kind,payload,status,attempts,created_at) VALUES (?,?,?,?,?,?,0,?)')
      .run(id('obx'), s.workspace_id, null, 'verify_order', JSON.stringify({ purchaseId: s.id }), 'pending', now());
  }
  return stuck.length;
}
