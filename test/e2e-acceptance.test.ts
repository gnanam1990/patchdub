// Reference end-to-end acceptance (TEST-PLAN §reference): six four-second
// cues on a 24s track; C2/C5 text edits; C4 retimed to 12.5-15.5s; two
// translations at 2 minor units each under a cap of 4; C4 reuses approved
// Tamil + timing check; union of paid intervals = 8s; a missing required
// term in C5 holds export until the reviewer approves the corrected digest;
// at cap 3 the all-or-none plan dispatches zero orders.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, drainWorker, seedEdition, startApp, stopApp, GLOSSARY_TERMS, type TestCtx } from './helpers.ts';
import { parseVtt } from '../src/vtt.ts';

let ctx: TestCtx;
before(async () => { ctx = await startApp(); });
after(async () => { await stopApp(ctx); });

test('acceptance: full producer→worker→reviewer→export journey', async () => {
  const f = await seedEdition(ctx);
  const t = f.tokens;

  // Repair window + bounded quote.
  const g = await api(ctx, 'POST', `/api/workspaces/${f.wsId}/glossaries`, {
    token: t.producer, body: { name: 'terms', terms: GLOSSARY_TERMS },
  });
  const plan = await api(ctx, 'POST', `/api/revisions/${f.newSourceRev}/repair-plans`, {
    token: t.producer, body: { capMinor: 4, unitPriceMinor: 2, glossaryId: g.body.id },
  });
  assert.equal(plan.body.totalMinor, 4);
  const approve = await api(ctx, 'POST', `/api/plans/${plan.body.id}/approve`, {
    token: t.producer, body: { idempotencyKey: 'e2e-approve', expectedVersion: 1 },
  });
  assert.equal(approve.body.dispatched, 2);
  assert.equal(approve.body.reservedMinor, 4);

  await drainWorker(ctx);
  const settled = ctx.db.prepare(
    "SELECT COUNT(*) n, SUM(amount_minor) total FROM purchases WHERE status = 'settled'",
  ).get() as { n: number; total: number };
  assert.equal(settled.n, 2);
  assert.equal(settled.total, 4);

  // C4: approved Tamil reused, timing check ran clean.
  const c4 = ctx.db.prepare(
    `SELECT p.status, p.variant_text FROM patches p JOIN cues c ON c.id = p.new_cue_id
     WHERE c.cue_id = 'C4' AND p.edition_id = ?`,
  ).get(f.editionId) as any;
  assert.equal(c4.status, 'reuse_checked');
  assert.equal(c4.variant_text, 'அளவீட்டைப் பதிவேற்றில் பதிவு செய்யவும்.');

  // C5 required term missing -> export held.
  const held = await api(ctx, 'POST', `/api/revisions/${f.newSourceRev}/exports`, {
    token: t.producer, body: { kind: 'final' },
  });
  assert.equal(held.status, 409);
  assert.equal(held.body.error.code, 'export_blocked');

  // Reviewer corrects C5 and approves both changed patches.
  const patches = ctx.db.prepare(
    `SELECT p.id, c.cue_id FROM patches p JOIN cues c ON c.id = p.new_cue_id
     WHERE p.edition_id = ? AND p.change_kind IN ('edit','insertion')`,
  ).all(f.editionId) as any[];
  for (const p of patches) {
    let cur = await api(ctx, 'GET', `/api/patches/${p.id}`, { token: t.reviewer });
    if (p.cue_id === 'C5') {
      await api(ctx, 'PUT', `/api/patches/${p.id}`, {
        token: t.reviewer,
        headers: { 'if-match': String(cur.body.patch.expected_version) },
        body: { variantText: 'எப்போதும் உங்கள் பாதுகாப்பு கட்டைப் பட்டை அணியவும்.' },
      });
      cur = await api(ctx, 'GET', `/api/patches/${p.id}`, { token: t.reviewer });
    }
    const rv = await api(ctx, 'PUT', `/api/patches/${p.id}/review`, {
      token: t.reviewer,
      headers: { 'if-match': String(cur.body.patch.expected_version) },
      body: { verdict: 'approve', reason: 'verified', digest: cur.body.patch.variant_hash },
    });
    assert.equal(rv.status, 200);
  }

  // Final export: reparsed artifact, exact approved revision.
  const fin = await api(ctx, 'POST', `/api/revisions/${f.newSourceRev}/exports`, {
    token: t.reviewer, body: { kind: 'final' },
  });
  const art = await fetch(`${ctx.base}/api/exports/${fin.body.id}/artifact`, {
    headers: { authorization: `Bearer ${t.distributor}` },
  }).then((r) => r.text());
  const cues = parseVtt(art);
  assert.equal(cues.length, 6);
  const byId = Object.fromEntries(cues.map((c) => [c.cueId, c]));
  assert.equal(byId.C4.startMs, 12500);
  assert.equal(byId.C4.endMs, 15500);
  assert.equal(byId.C4.text, 'அளவீட்டைப் பதிவேற்றில் பதிவு செய்யவும்.');
  assert.equal(byId.C5.text, 'எப்போதும் உங்கள் பாதுகாப்பு கட்டைப் பட்டை அணியவும்.');

  const man = await api(ctx, 'GET', `/api/exports/${fin.body.id}/manifest`, { token: t.distributor });
  assert.equal(man.body.usage.billableSeconds, 8); // union of paid intervals
  assert.equal(man.body.usage.totalMinor, 4);
  assert.equal(man.body.findings.some((x: any) => x.code === 'required_term_missing' && x.status === 'resolved'), true);

  // Second tenant cannot see the export (INV-07).
  const other = await api(ctx, 'POST', '/api/workspaces', undefined, { name: 'Rival' });
  const deny = await api(ctx, 'GET', `/api/exports/${fin.body.id}`, { token: other.body.producer.token });
  assert.equal(deny.status, 404);
});

test('acceptance: cap 3 on the same plan dispatches zero orders', async () => {
  const f = await seedEdition(ctx);
  const plan = await api(ctx, 'POST', `/api/revisions/${f.newSourceRev}/repair-plans`, {
    token: f.tokens.producer, body: { capMinor: 3, unitPriceMinor: 2 },
  });
  const approve = await api(ctx, 'POST', `/api/plans/${plan.body.id}/approve`, {
    token: f.tokens.producer, body: { idempotencyKey: 'e2e-cap3', expectedVersion: 1 },
  });
  assert.equal(approve.status, 200);
  assert.equal(approve.body.status, 'cap_exceeded');
  assert.equal(approve.body.dispatched, 0);
  await drainWorker(ctx);
  const n = ctx.db.prepare(
    'SELECT COUNT(*) n FROM purchases pu JOIN patches p ON p.id = pu.patch_id WHERE p.edition_id = ?',
  ).get(f.editionId) as { n: number };
  assert.equal(n.n, 0);
});
