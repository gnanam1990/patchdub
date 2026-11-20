import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, drainWorker, seedEdition, startApp, stopApp, GLOSSARY_TERMS, type TestCtx } from './helpers.ts';
import { variantDigest } from '../src/util/hash.ts';

let ctx: TestCtx;
before(async () => { ctx = await startApp(); });
after(async () => { await stopApp(ctx); });

async function flaggedEdition(ctx: TestCtx) {
  const f = await seedEdition(ctx);
  const g = await api(ctx, 'POST', `/api/workspaces/${f.wsId}/glossaries`, {
    token: f.tokens.producer, body: { name: 'terms', terms: GLOSSARY_TERMS },
  });
  const plan = await api(ctx, 'POST', `/api/revisions/${f.newSourceRev}/repair-plans`, {
    token: f.tokens.producer, body: { capMinor: 4, unitPriceMinor: 2, glossaryId: g.body.id },
  });
  await api(ctx, 'POST', `/api/plans/${plan.body.id}/approve`, {
    token: f.tokens.producer, body: { idempotencyKey: `app-${f.editionId}`, expectedVersion: 1 },
  });
  await drainWorker(ctx);
  return f;
}

function c5Patch(ctx: TestCtx, editionId: string) {
  return ctx.db.prepare(
    `SELECT p.* FROM patches p JOIN cues c ON c.id = p.new_cue_id
     WHERE p.edition_id = ? AND c.cue_id = 'C5'`,
  ).get(editionId) as any;
}

// T-009: a keyboard-only reviewer resolves C5, follows the next issue, and
// approves the corrected version (API path exercised; UI binds the same calls
// to keyboard controls in public/app.js).
test('T-009 reviewer resolves C5 finding then approves corrected digest', async () => {
  const f = await flaggedEdition(ctx);
  const t = f.tokens;

  // The review queue presents the flagged patch with its open finding.
  const patch = c5Patch(ctx, f.editionId);
  const view = await api(ctx, 'GET', `/api/patches/${patch.id}`, { token: t.reviewer });
  assert.equal(view.status, 200);
  const openFinding = view.body.findings.find((x: any) => x.status === 'open');
  assert.equal(openFinding.code, 'required_term_missing');
  assert.equal(view.body.patch.variant_hash.length, 64);

  // Resolve: edit variant to include the required term (versioned save).
  const corrected = 'எப்போதும் உங்கள் பாதுகாப்பு கட்டைப் பட்டை அணியவும்.';
  const edit = await api(ctx, 'PUT', `/api/patches/${patch.id}`, {
    token: t.reviewer,
    headers: { 'if-match': String(patch.expected_version) },
    body: { variantText: corrected },
  });
  assert.equal(edit.status, 200);
  const v2 = await api(ctx, 'GET', `/api/patches/${patch.id}`, { token: t.reviewer });
  const stillOpen = v2.body.findings.filter((x: any) => x.status === 'open');
  assert.equal(stillOpen.length, 0); // issue followed to resolution

  // Approve bound to the corrected digest.
  const review = await api(ctx, 'PUT', `/api/patches/${patch.id}/review`, {
    token: t.reviewer,
    headers: { 'if-match': String(v2.body.patch.expected_version) },
    body: { verdict: 'approve', reason: 'term restored', digest: v2.body.patch.variant_hash },
  });
  assert.equal(review.status, 200);
  assert.equal(review.body.status, 'approved');
  assert.equal(review.body.approved_digest, variantDigest(corrected));

  // The approval is attributed to the reviewer (INV-05).
  const reviewRow = ctx.db.prepare('SELECT reviewer_id, verdict FROM reviews WHERE patch_id = ?')
    .get(patch.id) as any;
  const reviewer = ctx.db.prepare('SELECT id FROM actors WHERE role = ? AND workspace_id = ?')
    .get('reviewer', f.wsId) as any;
  assert.equal(reviewRow.reviewer_id, reviewer.id);
});

// T-010: two browser tabs reviewing different C5 variants produce a
// stale-write response for the older tab.
test('T-010 concurrent tabs: older write gets stale-write 409', async () => {
  const f = await flaggedEdition(ctx);
  const t = f.tokens;
  const patch = c5Patch(ctx, f.editionId);

  // Both tabs read version N.
  const tabA = await api(ctx, 'GET', `/api/patches/${patch.id}`, { token: t.reviewer });
  const tabB = await api(ctx, 'GET', `/api/patches/${patch.id}`, { token: t.reviewer });
  assert.equal(tabA.body.patch.expected_version, tabB.body.patch.expected_version);
  const v = tabA.body.patch.expected_version;

  // Tab A saves its edit first.
  const editA = await api(ctx, 'PUT', `/api/patches/${patch.id}`, {
    token: t.reviewer,
    headers: { 'if-match': String(v) },
    body: { variantText: 'எப்போதும் உங்கள் பாதுகாப்பு கட்டைப் பட்டை அணியவும்.' },
  });
  assert.equal(editA.status, 200);

  // Tab B's save against the old version is rejected as stale.
  const editB = await api(ctx, 'PUT', `/api/patches/${patch.id}`, {
    token: t.reviewer,
    headers: { 'if-match': String(v) },
    body: { variantText: 'எப்போதும் உங்கள் பாதுகாப்பு தலைகவசம் அணியவும்.' },
  });
  assert.equal(editB.status, 409);
  assert.equal(editB.body.error.code, 'stale_write');

  // And tab B's review of the pre-edit digest is rejected too.
  const reviewB = await api(ctx, 'PUT', `/api/patches/${patch.id}/review`, {
    token: t.reviewer,
    headers: { 'if-match': String(v) },
    body: { verdict: 'approve', digest: tabB.body.patch.variant_hash },
  });
  assert.equal(reviewB.status, 409);

  // Missing If-Match is a precondition failure, not a silent write.
  const noMatch = await api(ctx, 'PUT', `/api/patches/${patch.id}`, {
    token: t.reviewer, body: { variantText: 'x' },
  });
  assert.equal(noMatch.status, 428);
});
