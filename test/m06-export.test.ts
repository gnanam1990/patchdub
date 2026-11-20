import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, drainWorker, seedEdition, startApp, stopApp, GLOSSARY_TERMS, type TestCtx } from './helpers.ts';
import { parseVtt } from '../src/vtt.ts';
import { billableUnionMs } from '../src/exports.ts';

let ctx: TestCtx;
before(async () => { ctx = await startApp(); });
after(async () => { await stopApp(ctx); });

async function approveC5Fix(ctx: TestCtx, editionId: string, reviewer: string, patchId: string) {
  const cur = await api(ctx, 'GET', `/api/patches/${patchId}`, { token: reviewer });
  await api(ctx, 'PUT', `/api/patches/${patchId}`, {
    token: reviewer,
    headers: { 'if-match': String(cur.body.patch.expected_version) },
    body: { variantText: 'எப்போதும் உங்கள் பாதுகாப்பு கட்டைப் பட்டை அணியவும்.' },
  });
  const v2 = await api(ctx, 'GET', `/api/patches/${patchId}`, { token: reviewer });
  return api(ctx, 'PUT', `/api/patches/${patchId}/review`, {
    token: reviewer,
    headers: { 'if-match': String(v2.body.patch.expected_version) },
    body: { verdict: 'approve', reason: 'term restored', digest: v2.body.patch.variant_hash },
  });
}

// T-012: an unresolved finding blocks final export; the labeled draft stays
// available.
test('T-012 open finding blocks final export, draft labeled', async () => {
  const f = await seedEdition(ctx);
  const g = await api(ctx, 'POST', `/api/workspaces/${f.wsId}/glossaries`, {
    token: f.tokens.producer, body: { name: 'terms', terms: GLOSSARY_TERMS },
  });
  const plan = await api(ctx, 'POST', `/api/revisions/${f.newSourceRev}/repair-plans`, {
    token: f.tokens.producer, body: { capMinor: 4, unitPriceMinor: 2, glossaryId: g.body.id },
  });
  await api(ctx, 'POST', `/api/plans/${plan.body.id}/approve`, {
    token: f.tokens.producer, body: { idempotencyKey: 't012-approve', expectedVersion: 1 },
  });
  await drainWorker(ctx);

  const blocked = await api(ctx, 'POST', `/api/revisions/${f.newSourceRev}/exports`, {
    token: f.tokens.producer, body: { kind: 'final' },
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'export_blocked');
  assert.ok(blocked.body.error.detail.blockers.length > 0);

  const draft = await api(ctx, 'POST', `/api/revisions/${f.newSourceRev}/exports`, {
    token: f.tokens.producer, body: { kind: 'draft' },
  });
  assert.equal(draft.status, 200);
  const artifact = await fetch(`${ctx.base}/api/exports/${draft.body.id}/artifact`, {
    headers: { authorization: `Bearer ${f.tokens.producer}` },
  });
  const text = await artifact.text();
  assert.match(text, /NOTE DRAFT PREVIEW - not approved/);

  // Distributors cannot touch drafts.
  const denied = await api(ctx, 'GET', `/api/exports/${draft.body.id}`, { token: f.tokens.distributor });
  assert.equal(denied.status, 403);
});

// T-011: reparse the final export; C4 carries the revised timing and accepted
// paid duration is eight seconds.
test('T-011 final export reparses; C4 retimed, billable union 8s', async () => {
  const f = await seedEdition(ctx);
  const t = f.tokens;
  const g = await api(ctx, 'POST', `/api/workspaces/${f.wsId}/glossaries`, {
    token: t.producer, body: { name: 'terms', terms: GLOSSARY_TERMS },
  });
  const plan = await api(ctx, 'POST', `/api/revisions/${f.newSourceRev}/repair-plans`, {
    token: t.producer, body: { capMinor: 4, unitPriceMinor: 2, glossaryId: g.body.id },
  });
  await api(ctx, 'POST', `/api/plans/${plan.body.id}/approve`, {
    token: t.producer, body: { idempotencyKey: 't011-approve', expectedVersion: 1 },
  });
  await drainWorker(ctx);

  // Approve C2 (clean translation) and C5 (after reviewer fixes the term).
  const patches = ctx.db.prepare(
    `SELECT p.id, c.cue_id, p.status FROM patches p JOIN cues c ON c.id = p.new_cue_id
     WHERE p.edition_id = ? AND p.change_kind IN ('edit','insertion')`,
  ).all(f.editionId) as any[];
  for (const p of patches) {
    if (p.cue_id === 'C5') {
      const r = await approveC5Fix(ctx, f.editionId, t.reviewer, p.id);
      assert.equal(r.status, 200);
    } else {
      const cur = await api(ctx, 'GET', `/api/patches/${p.id}`, { token: t.reviewer });
      const r = await api(ctx, 'PUT', `/api/patches/${p.id}/review`, {
        token: t.reviewer,
        headers: { 'if-match': String(cur.body.patch.expected_version) },
        body: { verdict: 'approve', reason: 'reads correctly', digest: cur.body.patch.variant_hash },
      });
      assert.equal(r.status, 200);
    }
  }

  const fin = await api(ctx, 'POST', `/api/revisions/${f.newSourceRev}/exports`, {
    token: t.reviewer, body: { kind: 'final' },
  });
  assert.equal(fin.status, 200);

  const artifact = await fetch(`${ctx.base}/api/exports/${fin.body.id}/artifact`, {
    headers: { authorization: `Bearer ${t.distributor}` },
  });
  assert.equal(artifact.status, 200);
  const vttText = await artifact.text();
  const reparsed = parseVtt(vttText);
  assert.equal(reparsed.length, 6);
  const c4 = reparsed.find((c) => c.cueId === 'C4');
  assert.equal(c4.startMs, 12500);
  assert.equal(c4.endMs, 15500);
  // INV-06: unaffected approved Tamil text is preserved verbatim.
  const c1 = reparsed.find((c) => c.cueId === 'C1');
  assert.equal(c1.text, 'வால்வு பாதுகாப்பு பாடநெறிக்கு வரவேற்கிறோம்.');
  const c4t = reparsed.find((c) => c.cueId === 'C4');
  assert.equal(c4t.text, 'அளவீட்டைப் பதிவேற்றில் பதிவு செய்யவும்.');

  const manifest = await api(ctx, 'GET', `/api/exports/${fin.body.id}/manifest`, { token: t.distributor });
  assert.equal(manifest.body.kind, 'final');
  assert.equal(manifest.body.usage.billableSeconds, 8);
  assert.equal(manifest.body.usage.paidItems, 2);
  assert.equal(manifest.body.usage.totalMinor, 4);
  assert.equal(manifest.body.parentHashes.newSource.length, 64);
  assert.equal(manifest.body.receipts.length, 2);
});

// Unit: the interval union counts overlapping paid intervals once.
test('billableUnionMs merges overlapping intervals', () => {
  assert.equal(billableUnionMs([{ start: 0, end: 4000 }, { start: 16000, end: 20000 }]), 8000);
  assert.equal(billableUnionMs([{ start: 0, end: 5000 }, { start: 3000, end: 8000 }]), 8000);
  assert.equal(billableUnionMs([{ start: 0, end: 4000 }, { start: 4000, end: 8000 }]), 8000);
  assert.equal(billableUnionMs([]), 0);
});
