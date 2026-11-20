// Replayable studio demonstration (FR-07): upload → align → bounded quote →
// purchase via local emulator → terminology review → approved export.
// Uses the labeled, rights-cleared sample fixtures only. Run: npm run demo
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { LocalSellerAdapter } from '../src/provider.ts';
import { runWorkerTick, sweepInFlight } from '../src/worker.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA = join(ROOT, 'data-demo');
const fixture = (n: string) => readFileSync(join(ROOT, 'fixtures', n), 'utf8');

const PORT = 0;
const db = openDb(join(DATA, 'demo.db'));
// The local seller emulator's deterministic translations for the sample
// lines; the C5 output deliberately omits the required glossary term so the
// terminology check has real work to do.
const adapter = new LocalSellerAdapter(db, {
  lexicon: {
    'Close the intake valve fully.': 'உள்ளீட்டு வால்வை முழுவதும் மூடவும்.',
    'Wear your safety harness at all times.': 'எப்போதும் உங்கள் கட்டைப் பட்டை அணியவும்.',
  },
});
const server = createApp({ db, adapter });
await new Promise<void>((r) => server.listen(PORT, r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function api(method: string, path: string, tokenOrOpts?: string | { token?: string; headers?: Record<string, string> }, body?: unknown) {
  const token = typeof tokenOrOpts === 'string' ? tokenOrOpts : tokenOrOpts?.token;
  const headers = typeof tokenOrOpts === 'object' ? tokenOrOpts.headers : {};
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
}

const say = (s: string) => console.log(`\n=== ${s}`);

say('1 · Bootstrap studio + roles');
const ws = await api('POST', '/api/workspaces', undefined, { name: 'Demo Studio (sample)', producerName: 'Priya' });
const wsId = ws.body.workspace.id;
const producer = ws.body.producer.token;
const tokens: Record<string, string> = { producer };
for (const role of ['editor', 'reviewer', 'distributor', 'operator']) {
  const r = await api('POST', `/api/workspaces/${wsId}/actors`, producer, { name: role, role });
  tokens[role] = r.body.token;
}
console.log('workspace:', wsId);
console.log('producer token:', producer);

say('2 · Editor imports previous source, approved Tamil, replacement source');
const ed = await api('POST', '/api/editions', tokens.editor, {
  workspaceId: wsId, title: 'Valve safety ep1 (labeled sample)', sourceLocale: 'en', targetLocale: 'ta',
});
const edId = ed.body.id;
const r1 = await api('POST', `/api/editions/${edId}/revisions`, tokens.editor, {
  kind: 'source', label: 'prev-source', content: fixture('prev-source.vtt'), idempotencyKey: 'demo-prev-src',
});
const r2 = await api('POST', `/api/editions/${edId}/revisions`, tokens.editor, {
  kind: 'target', label: 'approved-ta', content: fixture('prev-target.vtt'),
  sourceRevisionId: r1.body.revisionId, idempotencyKey: 'demo-prev-tgt',
});
const r3 = await api('POST', `/api/editions/${edId}/revisions`, tokens.editor, {
  kind: 'source', label: 'new-source', content: fixture('new-source.vtt'),
  parentId: r1.body.revisionId, idempotencyKey: 'demo-new-src',
});
console.log('revisions:', r1.body.revisionId, r2.body.revisionId, r3.body.revisionId);

say('3 · Alignment: C2/C5 edits, C4 retime');
await api('POST', `/api/revisions/${r3.body.revisionId}/alignment/recompute`, tokens.editor);
const aln = await api('GET', `/api/revisions/${r3.body.revisionId}/alignment`, producer);
for (const g of aln.body.groups) {
  console.log(` ${g.group_key} ${g.kind.padEnd(10)} ${g.reason}`);
}

say('4 · Producer approves bounded quote (cap 4, glossary pinned)');
const glo = await api('POST', `/api/workspaces/${wsId}/glossaries`, producer, {
  name: 'course-terms',
  terms: [{ source: 'safety', target: 'பாதுகாப்பு', required: true }],
});
const plan = await api('POST', `/api/revisions/${r3.body.revisionId}/repair-plans`, producer, {
  capMinor: 4, unitPriceMinor: 2, glossaryId: glo.body.id,
});
console.log('plan:', plan.body.id, 'total', plan.body.totalMinor, 'cap', plan.body.capMinor,
  'glossary', plan.body.glossaryDigest);
const approve = await api('POST', `/api/plans/${plan.body.id}/approve`, producer, {
  idempotencyKey: 'demo-approve', expectedVersion: 1,
});
console.log('approve:', approve.body.status, 'operation', approve.body.operationId,
  'dispatched', approve.body.dispatched);

say('5 · Worker dispatches + settles on the local emulator rail');
sweepInFlight(db);
for (let i = 0; i < 4; i++) {
  const { processed } = runWorkerTick(db, adapter);
  if (processed === 0) break;
}
const purchases = db.prepare('SELECT status, amount_minor, rail, external_ref FROM purchases').all();
console.log('purchases:', purchases);

say('6 · Reviewer resolves the required-term finding on C5 and approves both');
const c5 = db.prepare(`SELECT p.id FROM patches p JOIN cues c ON c.id = p.new_cue_id
  WHERE c.cue_id = 'C5'`).get() as { id: string };
const c2 = db.prepare(`SELECT p.id FROM patches p JOIN cues c ON c.id = p.new_cue_id
  WHERE c.cue_id = 'C2'`).get() as { id: string };
const cur = await api('GET', `/api/patches/${c5.id}`, tokens.reviewer);
console.log('C5 findings:', cur.body.findings.map((f: { code: string; status: string }) => `${f.code}:${f.status}`));
await api('PUT', `/api/patches/${c5.id}`, { token: tokens.reviewer, headers: { 'if-match': String(cur.body.patch.expected_version) } },
  { variantText: 'எப்போதும் உங்கள் பாதுகாப்பு கட்டைப் பட்டை அணியவும்.' });
for (const id of [c2.id, c5.id]) {
  const v = await api('GET', `/api/patches/${id}`, tokens.reviewer);
  const rv = await api('PUT', `/api/patches/${id}/review`, { token: tokens.reviewer, headers: { 'if-match': String(v.body.patch.expected_version) } },
    { verdict: 'approve', reason: 'verified', digest: v.body.patch.variant_hash });
  console.log('approve', id.slice(0, 14), rv.body.status);
}

say('7 · Final export + manifest');
const fin = await api('POST', `/api/revisions/${r3.body.revisionId}/exports`, tokens.reviewer, { kind: 'final' });
console.log('export:', fin.body);
const man = await api('GET', `/api/exports/${fin.body.id}/manifest`, tokens.distributor);
console.log('usage:', man.body.usage);
console.log('parentHashes:', man.body.parentHashes);
const artifact = await fetch(`${base}/api/exports/${fin.body.id}/artifact`, {
  headers: { authorization: `Bearer ${tokens.distributor}` },
});
console.log('--- exported WebVTT ---');
console.log(await artifact.text());

server.close();
console.log(`demo complete. database and artifacts under ${DATA}`);
console.log('to re-run cleanly: rm -rf data-demo && npm run demo');
