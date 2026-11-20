import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, drainWorker, fixture, seedEdition, startApp, stopApp, GLOSSARY_TERMS, type TestCtx } from './helpers.ts';
import { variantDigest } from '../src/util/hash.ts';

let ctx: TestCtx;
before(async () => { ctx = await startApp(); });
after(async () => { await stopApp(ctx); });

async function glossaryId(ctx: TestCtx, wsId: string, token: string): Promise<string> {
  const g = await api(ctx, 'POST', `/api/workspaces/${wsId}/glossaries`, {
    token, body: { name: 'course-terms', terms: GLOSSARY_TERMS },
  });
  return g.body.id;
}

// T-007: correcting the missing approved Tamil term in C5 resolves that
// finding at the new variant hash.
test('T-007 required-term correction resolves finding at new digest', async () => {
  const f = await seedEdition(ctx);
  const gid = await glossaryId(ctx, f.wsId, f.tokens.producer);
  const plan = await api(ctx, 'POST', `/api/revisions/${f.newSourceRev}/repair-plans`, {
    token: f.tokens.producer, body: { capMinor: 4, unitPriceMinor: 2, glossaryId: gid },
  });
  const approve = await api(ctx, 'POST', `/api/plans/${plan.body.id}/approve`, {
    token: f.tokens.producer, body: { idempotencyKey: 't007-approve', expectedVersion: 1 },
  });
  assert.equal(approve.body.status, 'approved');
  await drainWorker(ctx);

  const c5patch = ctx.db.prepare(
    `SELECT p.* FROM patches p JOIN cues c ON c.id = p.new_cue_id
     WHERE p.edition_id = ? AND c.cue_id = 'C5'`,
  ).get(f.editionId) as any;
  assert.equal(c5patch.status, 'flagged');
  const finding = ctx.db.prepare(
    "SELECT * FROM findings WHERE patch_id = ? AND code = 'required_term_missing'",
  ).get(c5patch.id) as any;
  assert.equal(finding.status, 'open');
  assert.equal(finding.source_offset_ms, 16000);

  // Reviewer corrects the variant to include the required term.
  const corrected = 'எப்போதும் உங்கள் பாதுகாப்பு கட்டைப் பட்டை அணியவும்.';
  const edit = await api(ctx, 'PUT', `/api/patches/${c5patch.id}`, {
    token: f.tokens.reviewer,
    headers: { 'if-match': String(c5patch.expected_version) },
    body: { variantText: corrected },
  });
  assert.equal(edit.status, 200);
  const after = ctx.db.prepare(
    "SELECT status, resolved_digest FROM findings WHERE id = ?",
  ).get(finding.id) as any;
  assert.equal(after.status, 'resolved');
  assert.equal(after.resolved_digest, variantDigest(corrected));
});

// T-008: a replacement that drops a source placeholder remains blocked even
// when all dictionary terms pass.
test('T-008 dropped placeholder stays blocked though glossary terms pass', async () => {
  const f = await seedEdition(ctx);
  const t = f.tokens;
  const old = await api(ctx, 'POST', `/api/editions/${f.editionId}/revisions`, {
    token: t.editor,
    body: { kind: 'source', label: 'ph-old', content: fixture('ph-old.vtt'), idempotencyKey: 'ph-old' },
  });
  const nw = await api(ctx, 'POST', `/api/editions/${f.editionId}/revisions`, {
    token: t.editor,
    body: {
      kind: 'source', label: 'ph-new', content: fixture('ph-new.vtt'),
      parentId: old.body.revisionId, idempotencyKey: 'ph-new',
    },
  });
  await api(ctx, 'POST', `/api/revisions/${nw.body.revisionId}/alignment/recompute`, { token: t.editor });

  // Glossary term passes in the vendor output; {user} placeholder is dropped.
  const g = await api(ctx, 'POST', `/api/workspaces/${f.wsId}/glossaries`, {
    token: t.producer,
    body: { name: 'ph-terms', terms: [{ source: 'Settings', target: 'அமைப்புகள்', required: true }] },
  });
  ctx.adapter['lexicon']['Settings for {user} are stored.'] = 'அமைப்புகள் சேமிக்கப்படுகின்றன.';

  const plan = await api(ctx, 'POST', `/api/revisions/${nw.body.revisionId}/repair-plans`, {
    token: t.producer, body: { capMinor: 4, unitPriceMinor: 2, glossaryId: g.body.id },
  });
  const approve = await api(ctx, 'POST', `/api/plans/${plan.body.id}/approve`, {
    token: t.producer, body: { idempotencyKey: 't008-approve', expectedVersion: 1 },
  });
  assert.equal(approve.body.status, 'approved');
  await drainWorker(ctx);

  const patch = ctx.db.prepare(
    `SELECT p.* FROM patches p JOIN cues c ON c.id = p.new_cue_id
     WHERE p.edition_id = ? AND c.cue_id = 'A1' ORDER BY p.created_at DESC LIMIT 1`,
  ).get(f.editionId) as any;
  const ph = ctx.db.prepare(
    "SELECT * FROM findings WHERE patch_id = ? AND code = 'placeholder_dropped'",
  ).get(patch.id) as any;
  assert.equal(ph.status, 'open');
  const terms = ctx.db.prepare(
    "SELECT COUNT(*) n FROM findings WHERE patch_id = ? AND code = 'required_term_missing' AND status = 'open'",
  ).get(patch.id) as { n: number };
  assert.equal(terms.n, 0); // all dictionary terms pass

  // Approval is refused while the placeholder finding is open.
  const review = await api(ctx, 'PUT', `/api/patches/${patch.id}/review`, {
    token: t.reviewer,
    headers: { 'if-match': String(patch.expected_version) },
    body: { verdict: 'approve', reason: 'terms pass', digest: patch.variant_hash },
  });
  assert.equal(review.status, 409);
  assert.equal(review.body.error.code, 'findings_open');
});
