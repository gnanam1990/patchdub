import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, bootstrap, fixture, startApp, stopApp, type TestCtx } from './helpers.ts';

let ctx: TestCtx;
before(async () => { ctx = await startApp(); });
after(async () => { await stopApp(ctx); });

// T-001: import the six-cue track twice; retrieve six cues and one revision ID.
test('T-001 six-cue import retries bind to one revision', async () => {
  const tokens = await bootstrap(ctx);
  const wsId = ctx.db.prepare('SELECT id FROM workspaces LIMIT 1').get() as { id: string };
  const ed = await api(ctx, 'POST', '/api/editions', {
    token: tokens.editor,
    body: { workspaceId: wsId.id, title: 'ep1', sourceLocale: 'en', targetLocale: 'ta' },
  });
  assert.equal(ed.status, 200);
  const body = {
    kind: 'source', label: 'v1', content: fixture('prev-source.vtt'), idempotencyKey: 'k-import-1',
  };
  const first = await api(ctx, 'POST', `/api/editions/${ed.body.id}/revisions`, { token: tokens.editor, body });
  assert.equal(first.status, 200);
  const second = await api(ctx, 'POST', `/api/editions/${ed.body.id}/revisions`, { token: tokens.editor, body });
  assert.equal(second.status, 200);
  assert.equal(second.body.revisionId, first.body.revisionId);
  assert.equal(second.body.deduplicated, true);

  const rev = await api(ctx, 'GET', `/api/revisions/${first.body.revisionId}`, { token: tokens.editor });
  assert.equal(rev.body.cues.length, 6);
  assert.equal(rev.body.cues[0].start_ms, 0);
  assert.equal(rev.body.cues[0].end_ms, 4000);
  assert.equal(rev.body.cues[3].cue_id, 'C4');
  assert.equal(rev.body.revision.input_sha256.length, 64);

  // Different payload under the same key is a conflict.
  const conflict = await api(ctx, 'POST', `/api/editions/${ed.body.id}/revisions`, {
    token: tokens.editor,
    body: { ...body, content: fixture('new-source.vtt') },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'idempotency_conflict');
});

// T-002: a cue ending before its start returns a line-level error and persists
// no active revision.
test('T-002 malformed timecode fails at line level, persists nothing', async () => {
  const tokens = ctx.tokens;
  const wsId = ctx.db.prepare('SELECT id FROM workspaces LIMIT 1').get() as { id: string };
  const ed = await api(ctx, 'POST', '/api/editions', {
    token: tokens.editor,
    body: { workspaceId: wsId.id, title: 'ep-bad', sourceLocale: 'en', targetLocale: 'ta' },
  });
  const bad = 'WEBVTT\n\nC1\n00:00:10.000 --> 00:00:05.000\nBackwards cue\n';
  const res = await api(ctx, 'POST', `/api/editions/${ed.body.id}/revisions`, {
    token: tokens.editor,
    body: { kind: 'source', label: 'bad', content: bad, idempotencyKey: 'k-bad' },
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'vtt_invalid');
  assert.equal(res.body.error.detail.line, 4);

  const count = ctx.db.prepare('SELECT COUNT(*) n FROM revisions WHERE edition_id = ?')
    .get(ed.body.id) as { n: number };
  assert.equal(count.n, 0);
  const active = ctx.db.prepare('SELECT active_revision_id FROM editions WHERE id = ?')
    .get(ed.body.id) as { active_revision_id: string | null };
  assert.equal(active.active_revision_id, null);
});

// Bounded parsing: oversized document rejected.
test('bounded upload: oversized document rejected before parse', async () => {
  const tokens = ctx.tokens;
  const wsId = ctx.db.prepare('SELECT id FROM workspaces LIMIT 1').get() as { id: string };
  const ed = await api(ctx, 'POST', '/api/editions', {
    token: tokens.editor,
    body: { workspaceId: wsId.id, title: 'ep-big', sourceLocale: 'en', targetLocale: 'ta' },
  });
  const huge = 'WEBVTT\n\n' + 'X\n00:00:00.000 --> 00:00:01.000\n' + 'y'.repeat(1_100_000) + '\n';
  const res = await api(ctx, 'POST', `/api/editions/${ed.body.id}/revisions`, {
    token: tokens.editor,
    body: { kind: 'source', label: 'big', content: huge, idempotencyKey: 'k-big' },
  });
  assert.equal(res.status, 422);
});

// Tenant scoping: a second workspace cannot read the first studio's subtitles.
test('tenant scope: other workspace actor cannot read revisions', async () => {
  const other = await api(ctx, 'POST', '/api/workspaces', { body: { name: 'Other Studio' } });
  const otherProducer = other.body.producer.token;
  const revId = ctx.db.prepare('SELECT id FROM revisions LIMIT 1').get() as { id: string };
  const res = await api(ctx, 'GET', `/api/revisions/${revId.id}`, { token: otherProducer });
  assert.equal(res.status, 404);
});
