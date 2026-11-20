import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { openDb, type DB } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { LocalSellerAdapter } from '../src/provider.ts';
import type { AddressInfo } from 'node:net';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function fixture(name: string): string {
  return readFileSync(join(ROOT, 'fixtures', name), 'utf8');
}

export interface TestCtx {
  db: DB;
  server: Server;
  base: string;
  adapter: LocalSellerAdapter;
  dir: string;
  tokens: Record<string, string>;
}

export interface ApiResult {
  status: number;
  body: Record<string, any>;
  headers: Headers;
}

export async function startApp(opts?: { settle?: 'auto' | 'manual' | 'unresolvable' }): Promise<TestCtx> {
  const dir = mkdtempSync(join(tmpdir(), 'patchdub-test-'));
  const db = openDb(join(dir, 'test.db'));
  const adapter = new LocalSellerAdapter(db, { settle: opts?.settle ?? 'auto', lexicon: LEXICON });
  const server = createApp({ db, adapter });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { db, server, base: `http://127.0.0.1:${port}`, adapter, dir, tokens: {} };
}

export function stopApp(ctx: TestCtx): Promise<void> {
  return new Promise((resolve) => ctx.server.close(() => resolve()));
}

export async function api(
  ctx: TestCtx, method: string, path: string,
  opts?: { token?: string; body?: unknown; headers?: Record<string, string> },
): Promise<ApiResult> {
  const res = await fetch(`${ctx.base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts?.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts?.headers ?? {}),
    },
    body: opts?.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: Record<string, any> = {};
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: res.status, body, headers: res.headers };
}

export const LEXICON: Record<string, string> = {
  'Close the intake valve fully.': 'உள்ளீட்டு வால்வை முழுவதும் மூடவும்.',
  // Deliberately misses the required glossary term பாதுகாப்பு.
  'Wear your safety harness at all times.': 'எப்போதும் உங்கள் கட்டைப் பட்டை அணியவும்.',
};

export const GLOSSARY_TERMS = [
  { source: 'safety', target: 'பாதுகாப்பு', required: true },
  { source: 'valve', target: 'வால்வு', required: false },
];

/** Bootstrap a workspace with the five roles. Returns token map by role. */
export async function bootstrap(ctx: TestCtx): Promise<Record<string, string>> {
  const ws = await api(ctx, 'POST', '/api/workspaces', {
    body: { name: 'Demo Studio', producerName: 'Priya' },
  });
  if (ws.status !== 200) throw new Error(`workspace create failed: ${JSON.stringify(ws.body)}`);
  const wsId = ws.body.workspace.id;
  const producer = ws.body.producer.token;
  const roles = ['editor', 'reviewer', 'distributor', 'operator'] as const;
  const tokens: Record<string, string> = { producer };
  for (const role of roles) {
    const r = await api(ctx, 'POST', `/api/workspaces/${wsId}/actors`, {
      token: producer, body: { name: role, role },
    });
    tokens[role] = r.body.token;
  }
  ctx.tokens = tokens;
  return tokens;
}

export interface EditionFixture {
  wsId: string; editionId: string; prevSourceRev: string; prevTargetRev: string;
  newSourceRev: string; tokens: Record<string, string>;
}

/** Import prev source, approved Tamil target and replacement source; align. */
export async function seedEdition(ctx: TestCtx, opts?: { align?: boolean }): Promise<EditionFixture> {
  const tokens = ctx.tokens.producer ? ctx.tokens : await bootstrap(ctx);
  const wsId = await workspaceId(ctx);
  const ed = await api(ctx, 'POST', '/api/editions', {
    token: tokens.editor,
    body: { workspaceId: wsId, title: 'Valve safety ep1', sourceLocale: 'en', targetLocale: 'ta' },
  });
  const editionId = ed.body.id;
  const r1 = await api(ctx, 'POST', `/api/editions/${editionId}/revisions`, {
    token: tokens.editor,
    body: { kind: 'source', label: 'prev-source', content: fixture('prev-source.vtt'), idempotencyKey: 'prev-src' },
  });
  const prevSourceRev = r1.body.revisionId;
  const r2 = await api(ctx, 'POST', `/api/editions/${editionId}/revisions`, {
    token: tokens.editor,
    body: {
      kind: 'target', label: 'approved-ta', content: fixture('prev-target.vtt'),
      sourceRevisionId: prevSourceRev, idempotencyKey: 'prev-tgt',
    },
  });
  const prevTargetRev = r2.body.revisionId;
  const r3 = await api(ctx, 'POST', `/api/editions/${editionId}/revisions`, {
    token: tokens.editor,
    body: {
      kind: 'source', label: 'new-source', content: fixture('new-source.vtt'),
      parentId: prevSourceRev, idempotencyKey: 'new-src',
    },
  });
  const newSourceRev = r3.body.revisionId;
  if (opts?.align !== false) {
    await api(ctx, 'POST', `/api/revisions/${newSourceRev}/alignment/recompute`, { token: tokens.editor });
  }
  return { wsId, editionId, prevSourceRev, prevTargetRev, newSourceRev, tokens };
}

async function workspaceId(ctx: TestCtx): Promise<string> {
  const rows = ctx.db.prepare('SELECT id FROM workspaces ORDER BY created_at LIMIT 1').all() as { id: string }[];
  return rows[0].id;
}
