import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ApiError, Router, authenticate, json, readBody, requireSameWorkspace,
  requireFields, str, int, type Actor,
} from './http.ts';
import { artifactDir, tx, type DB } from './db.ts';
import { parseVtt, VttError } from './vtt.ts';
import { id, now, sha256, token } from './util/hash.ts';
import { computeAlignment, listAlignment, resolveAlignmentGroup } from './align.ts';
import { createRepairPlan, approvePlan, getPlan, listPlansForRevision } from './plans.ts';
import { createGlossary, listGlossaries } from './glossary.ts';
import { getPatch, listPatchesForEdition, editPatchVariant, reviewPatch } from './patches.ts';
import { createExport, getExport, getExportArtifactPath } from './exports.ts';
import { operatorQueue, reconcilePurchase } from './recovery.ts';
import type { SellerAdapter } from './provider.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');

export interface AppOptions {
  db: DB;
  adapter?: SellerAdapter;
}

function audit(db: DB, actor: Actor, action: string, resource: string, detail: unknown): void {
  db.prepare(
    'INSERT INTO audit_log(id, workspace_id, actor_id, action, resource, detail, created_at) VALUES (?,?,?,?,?,?,?)',
  ).run(id('aud'), actor.workspace_id, actor.id, action, resource, JSON.stringify(detail ?? {}), now());
}

export function buildRouter(db: DB, adapter?: SellerAdapter): Router {
  const r = new Router();
  const ANY_MEMBER: Actor['role'][] = ['producer', 'editor', 'reviewer', 'distributor', 'operator'];

  // --- bootstrap ------------------------------------------------------------
  r.add('POST', '/api/workspaces', 'any', async (ctx) => {
    const name = str(ctx.body, 'name') || 'Studio';
    const locale = str(ctx.body, 'locale') || 'ta';
    const producerName = str(ctx.body, 'producerName') || 'producer';
    return tx(db, () => {
      const ws = { id: id('ws'), name, locale };
      db.prepare('INSERT INTO workspaces(id,name,locale,retention_days,created_at) VALUES (?,?,?,?,?)')
        .run(ws.id, name, locale, 90, now());
      const tok = token('pd_actor');
      const actorId = id('act');
      db.prepare('INSERT INTO actors(id,workspace_id,name,role,token_hash,created_at) VALUES (?,?,?,?,?,?)')
        .run(actorId, ws.id, producerName, 'producer', sha256(tok), now());
      return { status: 201, workspace: ws, producer: { id: actorId, name: producerName, role: 'producer', token: tok } };
    });
  });

  r.add('POST', '/api/workspaces/{wid}/actors', ['producer'], (ctx) => {
    requireFields(ctx.body, ['name', 'role']);
    const ws = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(ctx.params.wid);
    requireSameWorkspace(ctx.actor, ws?.id as string | undefined);
    const role = str(ctx.body, 'role') as Actor['role'];
    if (!['producer', 'editor', 'reviewer', 'distributor', 'operator'].includes(role)) {
      throw new ApiError(400, 'invalid_role', 'unknown role');
    }
    const tok = token('pd_actor');
    const actorId = id('act');
    db.prepare('INSERT INTO actors(id,workspace_id,name,role,token_hash,created_at) VALUES (?,?,?,?,?,?)')
      .run(actorId, ctx.params.wid, str(ctx.body, 'name'), role, sha256(tok), now());
    audit(db, ctx.actor, 'actor.create', actorId, { name: str(ctx.body, 'name'), role });
    return { id: actorId, name: str(ctx.body, 'name'), role, token: tok };
  });

  r.add('GET', '/api/workspaces/{wid}', ANY_MEMBER, (ctx) => {
    const ws = db.prepare('SELECT id,name,locale,retention_days,created_at FROM workspaces WHERE id = ?')
      .get(ctx.params.wid) as Record<string, unknown> | undefined;
    requireSameWorkspace(ctx.actor, ws?.id as string | undefined);
    const actors = db.prepare('SELECT id,name,role,created_at FROM actors WHERE workspace_id = ? ORDER BY created_at')
      .all(ctx.params.wid);
    const editions = db.prepare('SELECT id,title,source_locale,target_locale,created_at FROM editions WHERE workspace_id = ? ORDER BY created_at')
      .all(ctx.params.wid);
    return { workspace: ws, actors, editions, me: ctx.actor };
  });

  // --- editions -------------------------------------------------------------
  r.add('POST', '/api/editions', ['producer', 'editor'], (ctx) => {
    requireFields(ctx.body, ['workspaceId', 'title', 'sourceLocale', 'targetLocale']);
    const wsId = str(ctx.body, 'workspaceId');
    requireSameWorkspace(ctx.actor, wsId);
    const editionId = id('ed');
    db.prepare('INSERT INTO editions(id,workspace_id,title,source_locale,target_locale,created_at) VALUES (?,?,?,?,?,?)')
      .run(editionId, wsId, str(ctx.body, 'title'), str(ctx.body, 'sourceLocale'), str(ctx.body, 'targetLocale'), now());
    audit(db, ctx.actor, 'edition.create', editionId, { title: str(ctx.body, 'title') });
    return { id: editionId };
  });

  r.add('GET', '/api/editions/{id}', ANY_MEMBER, (ctx) => loadEdition(ctx, ctx.params.id));

  // --- revisions (FR-01) ------------------------------------------------------
  r.add('POST', '/api/editions/{id}/revisions', ['editor', 'producer'], (ctx) => {
    requireFields(ctx.body, ['kind', 'content']);
    const edition = loadEditionRow(ctx, ctx.params.id);
    const kind = str(ctx.body, 'kind');
    if (kind !== 'source' && kind !== 'target') throw new ApiError(400, 'invalid_kind', 'kind must be source or target');
    const content = str(ctx.body, 'content');
    const label = str(ctx.body, 'label');
    const idemKey = str(ctx.body, 'idempotencyKey') || null;
    const parentId = str(ctx.body, 'parentId') || null;
    const sourceRevisionId = str(ctx.body, 'sourceRevisionId') || null;
    const digest = sha256(content);

    // INV-01: same identity binds to one revision; different payload under the
    // same key is a conflict.
    if (idemKey) {
      const existing = db.prepare(
        'SELECT id, input_sha256 FROM revisions WHERE edition_id = ? AND kind = ? AND idempotency_key = ?',
      ).get(edition.id as string, kind, idemKey) as { id: string; input_sha256: string } | undefined;
      if (existing) {
        if (existing.input_sha256 !== digest) {
          throw new ApiError(409, 'idempotency_conflict', 'a different payload was already imported under this key');
        }
        return { revisionId: existing.id, deduplicated: true };
      }
    }

    let cues;
    try {
      cues = parseVtt(content);
    } catch (err) {
      if (err instanceof VttError) {
        throw new ApiError(422, 'vtt_invalid', err.message, { line: err.line });
      }
      throw err;
    }

    const rev = tx(db, () => {
      const revisionId = id('rev');
      const artifactPath = join(artifactDir(), `${revisionId}.vtt`);
      writeFileSync(artifactPath, content, 'utf8');
      db.prepare(`INSERT INTO revisions(id,edition_id,workspace_id,parent_id,kind,label,source_revision_id,
        input_sha256,artifact_path,idempotency_key,status,imported_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(revisionId, edition.id, edition.workspace_id, parentId, kind, label,
          sourceRevisionId, digest, artifactPath, idemKey, 'active', now());
      const insert = db.prepare(`INSERT INTO cues(id,revision_id,workspace_id,cue_id,seq,start_ms,end_ms,
        source_text,source_hash,approved_target_text) VALUES (?,?,?,?,?,?,?,?,?,?)`);
      cues.forEach((c, i) => {
        insert.run(id('cue'), revisionId, edition.workspace_id, c.cueId, i, c.startMs, c.endMs,
          c.text, sha256(c.text.normalize('NFC')), null);
      });
      if (kind === 'target' && sourceRevisionId) {
        carryApprovedTargets(db, revisionId, sourceRevisionId);
      }
      if (kind === 'source') {
        db.prepare('UPDATE editions SET active_revision_id = ? WHERE id = ?').run(revisionId, edition.id);
      }
      audit(db, ctx.actor, 'revision.import', revisionId, { kind, label, cueCount: cues.length, sha256: digest });
      return revisionId;
    });
    return { revisionId: rev, cueCount: cues.length };
  });

  r.add('GET', '/api/revisions/{id}', ANY_MEMBER, (ctx) => {
    const rev = loadRevisionRow(ctx, ctx.params.id);
    const cues = db.prepare(
      'SELECT id,cue_id,seq,start_ms,end_ms,source_text,source_hash,approved_target_text FROM cues WHERE revision_id = ? ORDER BY seq',
    ).all(rev.id as string);
    return { revision: rev, cues };
  });

  // --- alignment (FR-02) ------------------------------------------------------
  r.add('GET', '/api/revisions/{id}/alignment', ANY_MEMBER, (ctx) => {
    const rev = loadRevisionRow(ctx, ctx.params.id);
    return { groups: listAlignment(db, rev.id as string), unresolved: unresolvedGroups(db, rev.id as string) };
  });

  r.add('POST', '/api/revisions/{id}/alignment/recompute', ['editor', 'producer'], (ctx) => {
    const rev = loadRevisionRow(ctx, ctx.params.id);
    if (rev.kind !== 'source' || !rev.parent_id) {
      throw new ApiError(400, 'no_parent', 'alignment requires a source revision with a parent');
    }
    computeAlignment(db, rev.parent_id as string, rev.id as string);
    audit(db, ctx.actor, 'alignment.recompute', rev.id as string, {});
    return { groups: listAlignment(db, rev.id as string), unresolved: unresolvedGroups(db, rev.id as string) };
  });

  r.add('PUT', '/api/revisions/{id}/alignment/{groupKey}', ['editor', 'producer'], (ctx) => {
    const rev = loadRevisionRow(ctx, ctx.params.id);
    const out = resolveAlignmentGroup(db, ctx.actor, rev.id as string, ctx.params.groupKey, ctx.body);
    audit(db, ctx.actor, 'alignment.resolve', ctx.params.groupKey, ctx.body);
    return out;
  });

  // --- glossaries -------------------------------------------------------------
  r.add('POST', '/api/workspaces/{wid}/glossaries', ['producer', 'editor', 'reviewer'], (ctx) => {
    requireFields(ctx.body, ['name', 'terms']);
    requireSameWorkspace(ctx.actor, ctx.params.wid);
    const g = createGlossary(db, ctx.params.wid, str(ctx.body, 'name'), ctx.body.terms);
    audit(db, ctx.actor, 'glossary.create', g.id, { digest: g.digest });
    return g;
  });

  r.add('GET', '/api/workspaces/{wid}/glossaries', ANY_MEMBER, (ctx) => {
    requireSameWorkspace(ctx.actor, ctx.params.wid);
    return { glossaries: listGlossaries(db, ctx.params.wid) };
  });

  // --- repair plans (FR-02/FR-03) ---------------------------------------------
  r.add('POST', '/api/revisions/{id}/repair-plans', ['producer', 'editor'], (ctx) => {
    const rev = loadRevisionRow(ctx, ctx.params.id);
    const plan = createRepairPlan(db, ctx.actor, rev, ctx.body);
    audit(db, ctx.actor, 'plan.create', plan.id, { capMinor: plan.cap_minor, totalMinor: plan.total_minor });
    return plan;
  });

  r.add('GET', '/api/plans/{id}', ANY_MEMBER, (ctx) => getPlan(ctx.db, ctx.actor, ctx.params.id));
  r.add('GET', '/api/revisions/{id}/repair-plans', ANY_MEMBER, (ctx) => {
    const rev = loadRevisionRow(ctx, ctx.params.id);
    return { plans: listPlansForRevision(db, rev.id as string) };
  });

  r.add('POST', '/api/plans/{id}/approve', ['producer'], (ctx) => {
    const out = approvePlan(db, ctx.actor, ctx.params.id, ctx.body);
    audit(db, ctx.actor, 'plan.approve', ctx.params.id, out);
    return out;
  });

  // --- patches / review (FR-04/FR-05) ------------------------------------------
  r.add('GET', '/api/editions/{id}/patches', ANY_MEMBER, (ctx) => {
    const edition = loadEditionRow(ctx, ctx.params.id);
    return { patches: listPatchesForEdition(db, edition.id as string) };
  });

  r.add('GET', '/api/patches/{id}', ANY_MEMBER, (ctx) => getPatch(db, ctx.actor, ctx.params.id));

  r.add('PUT', '/api/patches/{id}', ['reviewer'], (ctx) => {
    const ifMatch = ctx.req.headers['if-match'];
    const out = editPatchVariant(db, ctx.actor, ctx.params.id, ctx.body, ifMatch ? String(ifMatch) : undefined);
    audit(db, ctx.actor, 'patch.edit', ctx.params.id, { version: out.expected_version });
    return out;
  });

  r.add('PUT', '/api/patches/{id}/review', ['reviewer'], (ctx) => {
    const ifMatch = ctx.req.headers['if-match'];
    const out = reviewPatch(db, ctx.actor, ctx.params.id, ctx.body, ifMatch ? String(ifMatch) : undefined);
    audit(db, ctx.actor, 'patch.review', ctx.params.id, out);
    return out;
  });

  // --- exports (FR-06) ----------------------------------------------------------
  r.add('POST', '/api/revisions/{id}/exports', ['producer', 'reviewer', 'editor'], (ctx) => {
    const rev = loadRevisionRow(ctx, ctx.params.id);
    const out = createExport(db, ctx.actor, rev, str(ctx.body, 'kind') || 'draft');
    audit(db, ctx.actor, 'export.create', out.id, { kind: out.kind, artifactHash: out.artifact_hash });
    return out;
  });

  r.add('GET', '/api/exports/{id}', ANY_MEMBER, (ctx) => getExport(db, ctx.actor, ctx.params.id));
  r.add('GET', '/api/exports/{id}/manifest', ANY_MEMBER, (ctx) => {
    const e = getExport(db, ctx.actor, ctx.params.id);
    return JSON.parse(e.manifest as string);
  });

  // --- operator / recovery (FR-07) -----------------------------------------------
  r.add('GET', '/api/operator/queue', ['operator', 'producer'], (ctx) => {
    const wsId = ctx.query.get('workspace_id') ?? ctx.actor.workspace_id;
    requireSameWorkspace(ctx.actor, wsId);
    return operatorQueue(db, wsId);
  });

  r.add('POST', '/api/purchases/{id}/reconcile', ['operator', 'producer'], (ctx) => {
    const out = reconcilePurchase(db, ctx.actor, ctx.params.id, adapter);
    audit(db, ctx.actor, 'purchase.reconcile', ctx.params.id, out);
    return out;
  });

  r.add('GET', '/api/exports/{id}/artifact', ANY_MEMBER, (ctx) => {
    const path = getExportArtifactPath(db, ctx.actor, ctx.params.id);
    ctx.res.writeHead(200, {
      'content-type': 'text/vtt; charset=utf-8',
      'content-disposition': `attachment; filename="${ctx.params.id}.vtt"`,
    });
    ctx.res.end(readFileSync(path));
    return undefined;
  });

  r.add('GET', '/api/editions/{id}/case', ANY_MEMBER, (ctx) => {
    const edition = loadEditionRow(ctx, ctx.params.id);
    const revisions = db.prepare(
      'SELECT id,kind,label,parent_id,source_revision_id,input_sha256,imported_at,status FROM revisions WHERE edition_id = ? ORDER BY imported_at',
    ).all(edition.id as string);
    const activeSource = db.prepare(
      "SELECT id FROM revisions WHERE edition_id = ? AND kind = 'source' ORDER BY imported_at DESC LIMIT 1",
    ).get(edition.id as string) as { id: string } | undefined;
    const alignment = activeSource ? listAlignment(db, activeSource.id) : [];
    const plans = activeSource ? listPlansForRevision(db, activeSource.id) : [];
    const patches = listPatchesForEdition(db, edition.id as string);
    const exports_ = db.prepare(
      'SELECT id,revision_id,kind,artifact_hash,manifest_hash,created_by,created_at FROM exports WHERE edition_id = ? ORDER BY created_at',
    ).all(edition.id as string);
    return { edition, revisions, alignment, plans, patches, exports: exports_, unresolvedGroups: activeSource ? unresolvedGroups(db, activeSource.id) : 0 };
  });

  return r;
}

function unresolvedGroups(db: DB, revisionId: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) n FROM alignments WHERE new_revision_id = ? AND status = 'needs_review'",
  ).get(revisionId) as { n: number };
  return row.n;
}

interface Row { [k: string]: unknown; }

function loadEditionRow(ctx: { db: DB; actor: Actor }, editionId: string): Row {
  const e = ctx.db.prepare('SELECT * FROM editions WHERE id = ?').get(editionId) as Row | undefined;
  requireSameWorkspace(ctx.actor, e?.workspace_id as string | undefined);
  return e!;
}

function loadRevisionRow(ctx: { db: DB; actor: Actor }, revisionId: string): Row {
  const rev = ctx.db.prepare('SELECT * FROM revisions WHERE id = ?').get(revisionId) as Row | undefined;
  requireSameWorkspace(ctx.actor, rev?.workspace_id as string | undefined);
  return rev!;
}

function loadEdition(ctx: { db: DB; actor: Actor }, editionId: string): unknown {
  const edition = loadEditionRow(ctx, editionId);
  const revisions = ctx.db.prepare(
    'SELECT id,kind,label,parent_id,source_revision_id,input_sha256,imported_at,status FROM revisions WHERE edition_id = ? ORDER BY imported_at',
  ).all(edition.id as string);
  return { edition, revisions };
}

/**
 * Associate imported approved target cues to the cues of a source revision:
 * cue_id match first, then same-seq order fallback. Stores the approved Tamil
 * text on the previous source cues for later carry-forward.
 */
export function carryApprovedTargets(db: DB, targetRevisionId: string, sourceRevisionId: string): void {
  const targets = db.prepare('SELECT cue_id,seq,source_text FROM cues WHERE revision_id = ? ORDER BY seq')
    .all(targetRevisionId) as { cue_id: string | null; seq: number; source_text: string }[];
  const sources = db.prepare('SELECT id,cue_id,seq FROM cues WHERE revision_id = ? ORDER BY seq')
    .all(sourceRevisionId) as { id: string; cue_id: string | null; seq: number }[];
  const byId = new Map(sources.filter((s) => s.cue_id).map((s) => [s.cue_id!, s]));
  const set = db.prepare('UPDATE cues SET approved_target_text = ? WHERE id = ?');
  targets.forEach((t) => {
    const hit = (t.cue_id && byId.get(t.cue_id)) || sources[t.seq];
    if (hit) set.run(t.source_text, hit.id);
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
};

function serveStatic(res: ServerResponse, path: string): boolean {
  const rel = path === '/' ? '/index.html' : path;
  const file = join(PUBLIC_DIR, rel.replace(/^\/+/, ''));
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) return false;
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
  return true;
}

export function createApp(opts: AppOptions): Server {
  const { db } = opts;
  const router = buildRouter(db, opts.adapter);
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.url === '/api/health') return json(res, 200, { ok: true });
      const isApi = req.url?.startsWith('/api/');
      if (!isApi) {
        if (!serveStatic(res, req.url ?? '/')) return json(res, 404, { error: { code: 'not_found' } });
        return;
      }
      const actor = authenticate(db, req);
      const rawBody = ['POST', 'PUT', 'PATCH'].includes(req.method ?? '') ? await readBody(req) : '';
      let body: Record<string, unknown> = {};
      if (rawBody) {
        try { body = JSON.parse(rawBody); } catch {
          throw new ApiError(400, 'invalid_json', 'request body must be JSON');
        }
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const handled = await router.dispatch({ req, res, db, query: url.searchParams, body, actor });
      if (!handled) json(res, 404, { error: { code: 'not_found', message: 'unknown route' } });
    } catch (err) {
      if (err instanceof ApiError) {
        json(res, err.status, { error: { code: err.code, message: err.message, detail: err.detail } });
      } else {
        console.error('unhandled error', err);
        json(res, 500, { error: { code: 'internal', message: 'internal error' } });
      }
    }
  });
}
