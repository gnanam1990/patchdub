import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, seedEdition, startApp, stopApp, LEXICON, type TestCtx } from './helpers.ts';
import { runWorkerTick, sweepInFlight } from '../src/worker.ts';
import { LocalSellerAdapter } from '../src/provider.ts';

async function approvedPlan(ctx: TestCtx, f: Awaited<ReturnType<typeof seedEdition>>, key: string) {
  const plan = await api(ctx, 'POST', `/api/revisions/${f.newSourceRev}/repair-plans`, {
    token: f.tokens.producer, body: { capMinor: 4, unitPriceMinor: 2 },
  });
  return api(ctx, 'POST', `/api/plans/${plan.body.id}/approve`, {
    token: f.tokens.producer, body: { idempotencyKey: key, expectedVersion: 1 },
  });
}

// T-013: restart after the provider accepts an order and attach the original
// receipt on reconciliation.
test('T-013 post-crash reconcile attaches the original receipt, no rebuy', async () => {
  const ctx = await startApp({ settle: 'manual' });
  try {
    const f = await seedEdition(ctx);
    await approvedPlan(ctx, f, 't013-approve');

    // Dispatch only — provider accepts, then the "process" dies before verify.
    runWorkerTick(ctx.db, ctx.adapter, { kinds: ['dispatch_order'] });
    const dispatched = ctx.db.prepare(
      "SELECT * FROM purchases WHERE status = 'dispatched'",
    ).all() as any[];
    assert.equal(dispatched.length, 2);
    const refs = dispatched.map((p) => p.external_ref);
    assert.ok(refs.every(Boolean));

    // Restart against an independently restored database that lost the verify
    // jobs: the sweep requeues them by original reference, no repurchase.
    ctx.db.prepare("DELETE FROM outbox WHERE kind = 'verify_order' AND status = 'pending'").run();
    const adapter2 = new LocalSellerAdapter(ctx.db, { settle: 'manual', lexicon: LEXICON });
    const requeued = sweepInFlight(ctx.db);
    assert.equal(requeued, 2); // in-flight verifications resumed, not repurchased
    // Provider still holds them as accepted: verify stays pending, no duplicate.
    runWorkerTick(ctx.db, adapter2, { kinds: ['verify_order'] });
    const ordersAfter = ctx.db.prepare('SELECT COUNT(*) n FROM provider_orders').get() as { n: number };
    assert.equal(ordersAfter.n, 2);

    // Provider settles later; operator reconciles by original reference.
    for (const ref of refs) adapter2._settle(ref);
    for (const p of dispatched) {
      const out = await api(ctx, 'POST', `/api/purchases/${p.id}/reconcile`, { token: f.tokens.operator });
      assert.equal(out.status, 200);
      assert.equal(out.body.state, 'reconciled');
      assert.equal(out.body.externalRef, p.external_ref);
    }
    const final = ctx.db.prepare('SELECT status, receipt, amount_minor FROM purchases').all() as any[];
    assert.equal(final.every((p) => p.status === 'reconciled' && p.receipt), true);
    assert.equal(final.reduce((s, p) => s + p.amount_minor, 0), 4);
    // Still exactly two provider orders — restart did not double-buy (INV-07).
    assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM provider_orders').get() as any).n, 2);
  } finally {
    await stopApp(ctx);
  }
});

// T-014: when the seller cannot resolve an uncertain payment, keep the item
// pending and do not auto-repurchase.
test('T-014 unresolvable settlement stays pending, no auto-repurchase', async () => {
  const ctx = await startApp({ settle: 'unresolvable' });
  try {
    const f = await seedEdition(ctx);
    await approvedPlan(ctx, f, 't014-approve');
    runWorkerTick(ctx.db, ctx.adapter, { kinds: ['dispatch_order'] });
    sweepInFlight(ctx.db);
    // Verify observes 'unknown' -> purchase parked for the operator.
    for (let i = 0; i < 3; i++) runWorkerTick(ctx.db, ctx.adapter, { kinds: ['verify_order'] });
    const unknown = ctx.db.prepare("SELECT * FROM purchases WHERE status = 'unknown'").all() as any[];
    assert.equal(unknown.length, 2);

    // Operator queue surfaces them.
    const q = await api(ctx, 'GET', `/api/operator/queue?workspace_id=${f.wsId}`, { token: f.tokens.operator });
    assert.equal(q.body.unknownPurchases.length, 2);

    // Reconcile still cannot resolve: item remains pending, no new order.
    const out = await api(ctx, 'POST', `/api/purchases/${unknown[0].id}/reconcile`, { token: f.tokens.operator });
    assert.equal(out.body.state, 'unknown');
    const still = ctx.db.prepare("SELECT status FROM purchases WHERE id = ?").get(unknown[0].id) as any;
    assert.equal(still.status, 'unknown');
    assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM provider_orders').get() as any).n, 2);
    // More worker ticks create no replacement orders.
    runWorkerTick(ctx.db, ctx.adapter);
    assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM provider_orders').get() as any).n, 2);
  } finally {
    await stopApp(ctx);
  }
});
