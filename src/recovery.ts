import { now } from './util/hash.ts';
import { ApiError, type Actor } from './http.ts';
import type { DB } from './db.ts';
import { applySettledResult, markUnknown } from './worker.ts';
import type { SellerAdapter } from './provider.ts';

/** Operator queue: uncertain settlements and stalled work, per FR-07. */
export function operatorQueue(db: DB, workspaceId: string) {
  const unknownPurchases = db.prepare(
    `SELECT pu.id, pu.patch_id, pu.plan_id, pu.provider_id, pu.quote_minor, pu.rail,
            pu.external_ref, pu.status, pu.updated_at
     FROM purchases pu WHERE pu.workspace_id = ? AND pu.status IN ('unknown','dispatched')
     ORDER BY pu.updated_at`,
  ).all(workspaceId);
  const pendingOutbox = db.prepare(
    "SELECT id, kind, attempts, created_at FROM outbox WHERE workspace_id = ? AND status = 'pending' ORDER BY created_at",
  ).all(workspaceId);
  const stalled = db.prepare(
    `SELECT id, kind, status, created_at FROM operations
     WHERE workspace_id = ? AND status NOT IN ('approved','cap_exceeded') ORDER BY created_at`,
  ).all(workspaceId);
  return { unknownPurchases, pendingOutbox, stalledOperations: stalled };
}

/**
 * Reconcile an uncertain purchase by its ORIGINAL external reference. If the
 * provider still cannot resolve it the purchase stays pending/unknown and no
 * replacement order is created (T-014).
 */
export function reconcilePurchase(
  db: DB, actor: Actor, purchaseId: string, adapter?: SellerAdapter,
) {
  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchaseId) as
    Record<string, unknown> | undefined;
  if (!purchase || purchase.workspace_id !== actor.workspace_id) {
    throw new ApiError(404, 'not_found', 'purchase not found');
  }
  if (!purchase.external_ref) {
    throw new ApiError(409, 'no_reference', 'purchase has no provider reference to reconcile');
  }
  if (!adapter) {
    return { purchaseId, state: 'unresolvable', reason: 'no provider adapter configured' };
  }
  const status = adapter.status(purchase.external_ref as string);
  if (status.state === 'settled') {
    applySettledResult(db, purchaseId, status.receipt ?? {}, status.results ?? {}, 'reconciled');
    return { purchaseId, state: 'reconciled', externalRef: purchase.external_ref };
  }
  if (status.state === 'unknown' || status.state === 'failed') {
    markUnknown(db, purchaseId);
    return { purchaseId, state: 'unknown', externalRef: purchase.external_ref };
  }
  db.prepare('UPDATE purchases SET updated_at = ? WHERE id = ?').run(now(), purchaseId);
  return { purchaseId, state: 'pending', externalRef: purchase.external_ref };
}
