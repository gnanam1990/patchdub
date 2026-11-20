import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, seedEdition, startApp, stopApp, type TestCtx } from './helpers.ts';
import { runWorkerTick } from '../src/worker.ts';

let ctx: TestCtx;
before(async () => { ctx = await startApp(); });
after(async () => { await stopApp(ctx); });

async function planApproveWork(ctx: TestCtx, f: Awaited<ReturnType<typeof seedEdition>>, capMinor: number, key: string) {
  const plan = await api(ctx, 'POST', `/api/revisions/${f.newSourceRev}/repair-plans`, {
    token: f.tokens.producer, body: { capMinor, unitPriceMinor: 2 },
  });
  const approve = await api(ctx, 'POST', `/api/plans/${plan.body.id}/approve`, {
    token: f.tokens.producer, body: { idempotencyKey: key, expectedVersion: 1 },
  });
  return { plan, approve };
}

// T-005: the six-cue fixture reserves and records four minor units over two items.
test('T-005 cap-4 plan reserves 4 minor units over two translated items', async () => {
  const f = await seedEdition(ctx);
  const { approve } = await planApproveWork(ctx, f, 4, 't005-approve');
  assert.equal(approve.status, 200);
  assert.equal(approve.body.status, 'approved');
  assert.equal(approve.body.dispatched, 2);
  assert.equal(approve.body.reservedMinor, 4);

  // Worker dispatches and settles against the local emulator.
  runWorkerTick(ctx.db, ctx.adapter, { kinds: ['dispatch_order'] });
  runWorkerTick(ctx.db, ctx.adapter, { kinds: ['verify_order'] });

  const purchases = ctx.db.prepare(
    'SELECT pu.* FROM purchases pu JOIN patches p ON p.id = pu.patch_id WHERE p.edition_id = ? ORDER BY pu.created_at',
  ).all(f.editionId) as any[];
  assert.equal(purchases.length, 2);
  assert.equal(purchases.every((p) => p.status === 'settled'), true);
  assert.equal(purchases.reduce((s, p) => s + p.amount_minor, 0), 4);
  assert.equal(purchases.every((p) => p.external_ref && p.receipt), true);
  assert.equal(purchases.every((p) => p.rail === 'local-emulator'), true);

  const patches = ctx.db.prepare(
    "SELECT status, variant_text FROM patches WHERE edition_id = ? AND change_kind IN ('edit','insertion') ORDER BY start_ms",
  ).all(f.editionId) as any[];
  assert.equal(patches.length, 2);
  assert.equal(patches.every((p) => p.variant_text && p.variant_text.length > 0), true);
});

// T-006: a cap of three creates zero dispatched orders, even with two
// concurrent approval clicks.
test('T-006 cap-3 all-or-none dispatches nothing, concurrently safe', async () => {
  const f = await seedEdition(ctx);
  const { plan } = await planApproveWork(ctx, f, 3, 't006-approve');
  // planApproveWork already approved once with cap 3 -> cap_exceeded; verify
  const first = await api(ctx, 'POST', `/api/plans/${plan.body.id}/approve`, {
    token: f.tokens.producer, body: { idempotencyKey: 't006-approve', expectedVersion: 1 },
  });
  // Two concurrent retries under a second key.
  const [a, b] = await Promise.all([
    api(ctx, 'POST', `/api/plans/${plan.body.id}/approve`, {
      token: f.tokens.producer, body: { idempotencyKey: 't006-approve-2', expectedVersion: 1 },
    }),
    api(ctx, 'POST', `/api/plans/${plan.body.id}/approve`, {
      token: f.tokens.producer, body: { idempotencyKey: 't006-approve-3', expectedVersion: 1 },
    }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'cap_exceeded');
  assert.equal(first.body.dispatched, 0);
  // Concurrent clicks: either idempotent replay of cap_exceeded or
  // plan_not_approvable — never a dispatch.
  for (const r of [a, b]) {
    if (r.status === 200) {
      assert.equal(r.body.dispatched, 0);
      assert.equal(r.body.status, 'cap_exceeded');
    } else {
      assert.equal(r.status, 409);
    }
  }

  runWorkerTick(ctx.db, ctx.adapter);
  const orderCount = ctx.db.prepare(
    'SELECT COUNT(*) n FROM purchases pu JOIN patches p ON p.id = pu.patch_id WHERE p.edition_id = ?',
  ).get(f.editionId) as { n: number };
  assert.equal(orderCount.n, 0);
  // No provider order was created for this edition's plan items.
  const providerOrders = ctx.db.prepare(
    `SELECT COUNT(*) n FROM provider_orders po
     WHERE EXISTS (SELECT 1 FROM purchases pu JOIN patches p ON p.id = pu.patch_id
                   WHERE p.edition_id = ? AND po.order_key = pu.order_key)`,
  ).get(f.editionId) as { n: number };
  assert.equal(providerOrders.n, 0);
});

// INV-03: a stale plan version cannot authorize an order.
test('INV-03 stale plan version is rejected', async () => {
  const f = await seedEdition(ctx);
  const plan = await api(ctx, 'POST', `/api/revisions/${f.newSourceRev}/repair-plans`, {
    token: f.tokens.producer, body: { capMinor: 4, unitPriceMinor: 2 },
  });
  const stale = await api(ctx, 'POST', `/api/plans/${plan.body.id}/approve`, {
    token: f.tokens.producer, body: { idempotencyKey: 'stale-1', expectedVersion: 99 },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'stale_plan');

  // Idempotent approve replay returns the stored outcome.
  const ok = await api(ctx, 'POST', `/api/plans/${plan.body.id}/approve`, {
    token: f.tokens.producer, body: { idempotencyKey: 'replay-1', expectedVersion: 1 },
  });
  assert.equal(ok.status, 200);
  const replay = await api(ctx, 'POST', `/api/plans/${plan.body.id}/approve`, {
    token: f.tokens.producer, body: { idempotencyKey: 'replay-1', expectedVersion: 1 },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  const conflict = await api(ctx, 'POST', `/api/plans/${plan.body.id}/approve`, {
    token: f.tokens.producer, body: { idempotencyKey: 'replay-1', expectedVersion: 7 },
  });
  assert.equal(conflict.status, 409);
});
