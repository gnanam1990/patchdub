import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, fixture, seedEdition, startApp, stopApp, type TestCtx } from './helpers.ts';

let ctx: TestCtx;
before(async () => { ctx = await startApp(); });
after(async () => { await stopApp(ctx); });

// T-003: classify C2 and C5 as edits and C4 as retime with zero translation
// units for C4.
test('T-003 alignment classifies edits vs retime', async () => {
  const f = await seedEdition(ctx);
  const res = await api(ctx, 'GET', `/api/revisions/${f.newSourceRev}/alignment`, { token: f.tokens.producer });
  assert.equal(res.status, 200);
  const groups = res.body.groups;
  const byKind = (k: string) => groups.filter((g: any) => g.kind === k);
  assert.equal(byKind('unchanged').length, 3); // C1, C3, C6
  assert.equal(byKind('edit').length, 2);      // C2, C5
  assert.equal(byKind('retime').length, 1);    // C4

  const plan = await api(ctx, 'POST', `/api/revisions/${f.newSourceRev}/repair-plans`, {
    token: f.tokens.producer,
    body: { capMinor: 4, unitPriceMinor: 2 },
  });
  assert.equal(plan.status, 200);
  const retimeItems = plan.body.items.filter((i: any) => i.kind === 'retime');
  assert.equal(retimeItems.length, 1);
  assert.equal(retimeItems[0].priceMinor, 0); // zero translation units for C4
  const editItems = plan.body.items.filter((i: any) => i.kind === 'edit');
  assert.equal(editItems.length, 2);
  assert.equal(plan.body.totalMinor, 4); // 2 edits x 2 minor units

  // INV-02: approved Tamil carried onto the retimed cue only (plus unchanged).
  const rev = await api(ctx, 'GET', `/api/revisions/${f.newSourceRev}`, { token: f.tokens.producer });
  const c4 = rev.body.cues.find((c: any) => c.cue_id === 'C4');
  assert.equal(c4.approved_target_text, 'அளவீட்டைப் பதிவேற்றில் பதிவு செய்யவும்.');
  const c2 = rev.body.cues.find((c: any) => c.cue_id === 'C2');
  assert.equal(c2.approved_target_text, null); // edited cue must not carry old Tamil
});

// T-004: two identical adjacent lines crossing a cut open a mapping review
// before the quote can be approved.
test('T-004 ambiguous identical lines block quote approval until resolved', async () => {
  const f = await seedEdition(ctx);
  const ed = f.editionId;
  const t = f.tokens;

  const old = await api(ctx, 'POST', `/api/editions/${ed}/revisions`, {
    token: t.editor,
    body: { kind: 'source', label: 'amb-old', content: fixture('amb-old.vtt'), idempotencyKey: 'amb-old' },
  });
  const nw = await api(ctx, 'POST', `/api/editions/${ed}/revisions`, {
    token: t.editor,
    body: {
      kind: 'source', label: 'amb-new', content: fixture('amb-new.vtt'),
      parentId: old.body.revisionId, idempotencyKey: 'amb-new',
    },
  });
  await api(ctx, 'POST', `/api/revisions/${nw.body.revisionId}/alignment/recompute`, { token: t.editor });
  const aln = await api(ctx, 'GET', `/api/revisions/${nw.body.revisionId}/alignment`, { token: t.producer });
  const ambiguous = aln.body.groups.filter((g: any) => g.status === 'needs_review');
  assert.equal(ambiguous.length >= 1, true);
  assert.equal(aln.body.unresolved >= 1, true);

  // Quote approval must refuse while the mapping review is open.
  const plan = await api(ctx, 'POST', `/api/revisions/${nw.body.revisionId}/repair-plans`, {
    token: t.producer, body: { capMinor: 10, unitPriceMinor: 2 },
  });
  assert.equal(plan.status, 200);
  const approve = await api(ctx, 'POST', `/api/plans/${plan.body.id}/approve`, {
    token: t.producer, body: { idempotencyKey: 'amb-approve-1', expectedVersion: 1 },
  });
  assert.equal(approve.status, 409);
  assert.equal(approve.body.error.code, 'alignment_unresolved');

  // Producer resolves the ambiguous group manually.
  const grp = ambiguous[0];
  const resolve = await api(ctx, 'PUT', `/api/revisions/${nw.body.revisionId}/alignment/${grp.group_key}`, {
    token: t.producer,
    body: { kind: 'retime', reason: 'first "Stand by." follows the cut', oldCueIds: grp.old_cue_ids.slice(0, 1), newCueIds: grp.new_cue_ids },
  });
  assert.equal(resolve.status, 200);
  assert.equal(resolve.body.status, 'resolved');

  // Resolving the mapping stales the earlier priced plan (INV-03 surface).
  const planAfter = await api(ctx, 'GET', `/api/plans/${plan.body.id}`, { token: t.producer });
  assert.equal(planAfter.body.plan.status, 'stale');
});
