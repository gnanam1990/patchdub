import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { id, now, sha256 } from './util/hash.ts';
import { ApiError, type Actor } from './http.ts';
import { exportDir, tx, type DB } from './db.ts';
import { serializeVtt } from './vtt.ts';
import { listAlignment } from './align.ts';
import { openFindingsForEdition } from './checks.ts';

interface Row { [k: string]: unknown }

/**
 * Merge paid patch intervals and return the union length in milliseconds
 * (INV-06: overlapping paid intervals count once).
 */
export function billableUnionMs(intervals: { start: number; end: number }[]): number {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart: number | null = null;
  let curEnd = 0;
  for (const iv of sorted) {
    if (curStart === null) { curStart = iv.start; curEnd = iv.end; continue; }
    if (iv.start <= curEnd) { curEnd = Math.max(curEnd, iv.end); continue; }
    total += curEnd - curStart;
    curStart = iv.start;
    curEnd = iv.end;
  }
  if (curStart !== null) total += curEnd - curStart;
  return total;
}

function blockersForFinal(db: DB, revisionId: string, editionId: string): string[] {
  const blockers: string[] = [];
  const unresolved = db.prepare(
    "SELECT COUNT(*) n FROM alignments WHERE new_revision_id = ? AND status = 'needs_review'",
  ).get(revisionId) as { n: number };
  if (unresolved.n > 0) blockers.push(`${unresolved.n} alignment group(s) unresolved`);

  const unapproved = db.prepare(
    "SELECT COUNT(*) n FROM patches WHERE edition_id = ? AND change_kind IN ('edit','insertion') AND status != 'approved'",
  ).get(editionId) as { n: number };
  if (unapproved.n > 0) blockers.push(`${unapproved.n} changed patch(es) not approved`);

  const openFindings = openFindingsForEdition(db, editionId) as unknown[];
  if (openFindings.length > 0) blockers.push(`${openFindings.length} finding(s) open`);

  const unresolvedPurchases = db.prepare(
    `SELECT COUNT(*) n FROM purchases pu JOIN patches p ON p.id = pu.patch_id
     WHERE p.edition_id = ? AND pu.status IN ('dispatched','unknown','reserved')`,
  ).get(editionId) as { n: number };
  if (unresolvedPurchases.n > 0) blockers.push(`${unresolvedPurchases.n} purchase(s) unresolved`);
  return blockers;
}

export function createExport(db: DB, actor: Actor, rev: Row, kind: string) {
  if (kind !== 'draft' && kind !== 'final') throw new ApiError(400, 'invalid_kind', 'kind must be draft or final');
  const editionId = rev.edition_id as string;

  if (kind === 'final') {
    const blockers = blockersForFinal(db, rev.id as string, editionId);
    if (blockers.length > 0) {
      throw new ApiError(409, 'export_blocked', 'final export blocked', { blockers });
    }
  }

  return tx(db, () => {
    const cues = db.prepare('SELECT * FROM cues WHERE revision_id = ? ORDER BY seq').all(rev.id as string) as Row[];
    const groups = listAlignment(db, rev.id as string);
    const groupByNewCue = new Map<string, Row>();
    for (const gr of groups) for (const cid of gr.new_cue_ids as string[]) groupByNewCue.set(cid, gr);

    const outCues: { cueId: string | null; startMs: number; endMs: number; text: string }[] = [];
    for (const cue of cues) {
      const grp = groupByNewCue.get(cue.id as string);
      let text: string | null = null;
      if (!grp || grp.kind === 'unchanged' || grp.kind === 'retime') {
        text = (cue.approved_target_text as string | null) ?? `[untranslated] ${cue.source_text}`;
      } else if (grp.kind === 'edit' || grp.kind === 'insertion') {
        const patch = db.prepare(
          'SELECT variant_text, variant_hash, approved_digest, status FROM patches WHERE new_cue_id = ? ORDER BY created_at DESC LIMIT 1',
        ).get(cue.id as string) as Row | undefined;
        if (patch) {
          const useApproved = kind === 'final' || (patch.approved_digest && patch.approved_digest === patch.variant_hash);
          text = useApproved ? (patch.variant_text as string) : `[proposed] ${patch.variant_text ?? cue.source_text}`;
        } else {
          text = `[pending] ${cue.source_text}`;
        }
      } else if (grp.kind === 'ambiguous' || grp.status === 'needs_review') {
        if (kind === 'final') throw new ApiError(409, 'export_blocked', 'unresolved alignment');
        text = `[ambiguous] ${cue.source_text}`;
      }
      if (text !== null) {
        outCues.push({ cueId: cue.cue_id as string | null, startMs: cue.start_ms as number, endMs: cue.end_ms as number, text });
      }
    }

    const note = kind === 'draft' ? 'DRAFT PREVIEW - not approved for distribution' : undefined;
    const artifact = serializeVtt(outCues, note);
    const artifactHash = sha256(artifact);

    // Manifest: parent hashes, findings and accepted paid usage.
    const parent = rev.parent_id
      ? db.prepare('SELECT input_sha256 FROM revisions WHERE id = ?').get(rev.parent_id as string) as Row | undefined
      : undefined;
    const targetRev = db.prepare(
      "SELECT input_sha256 FROM revisions WHERE edition_id = ? AND kind = 'target' ORDER BY imported_at DESC LIMIT 1",
    ).get(editionId) as Row | undefined;
    const findings = db.prepare(
      'SELECT f.id, f.patch_id, f.kind, f.code, f.message, f.status, f.resolved_digest, f.source_offset_ms FROM findings f JOIN patches p ON p.id = f.patch_id WHERE p.edition_id = ? ORDER BY f.created_at',
    ).all(editionId);
    const paid = db.prepare(
      `SELECT pu.id, pu.patch_id, pu.external_ref, pu.amount_minor, pu.quote_minor, pu.rail, pu.token, pu.status,
              p.start_ms, p.end_ms
       FROM purchases pu JOIN patches p ON p.id = pu.patch_id
       WHERE p.edition_id = ? AND pu.status IN ('settled','reconciled')`,
    ).all(editionId) as Row[];
    const billableMs = billableUnionMs(paid.map((p) => ({ start: p.start_ms as number, end: p.end_ms as number })));
    const totalMinor = paid.reduce((s, p) => s + ((p.amount_minor ?? p.quote_minor) as number), 0);

    const exportId = id('exp');
    const manifest = {
      exportId, kind, editionId, revisionId: rev.id,
      parentHashes: {
        newSource: rev.input_sha256,
        previousSource: parent?.input_sha256 ?? null,
        approvedTarget: targetRev?.input_sha256 ?? null,
      },
      generatedBy: actor.id,
      generatedByRole: actor.role,
      generatedAt: now(),
      draft: kind === 'draft',
      findings,
      usage: {
        paidItems: paid.length,
        totalMinor,
        token: 'CREDITS',
        rail: 'local-emulator',
        billableMs,
        billableSeconds: billableMs / 1000,
      },
      receipts: paid.map((p) => ({
        externalRef: p.external_ref, amountMinor: p.amount_minor ?? p.quote_minor,
        rail: p.rail, token: p.token, state: p.status,
      })),
      artifactHash,
    };
    const manifestJson = JSON.stringify(manifest, null, 2);
    const manifestHash = sha256(manifestJson);
    const artifactPath = join(exportDir(), `${exportId}.vtt`);
    writeFileSync(artifactPath, artifact, 'utf8');

    db.prepare(`INSERT INTO exports(id,workspace_id,edition_id,revision_id,kind,artifact_path,
      artifact_hash,manifest_hash,manifest,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(exportId, actor.workspace_id, editionId, rev.id, kind, artifactPath,
        artifactHash, manifestHash, manifestJson, actor.id, now());
    return { id: exportId, kind, artifact_hash: artifactHash, manifest_hash: manifestHash };
  });
}

export function getExport(db: DB, actor: Actor, exportId: string): Row {
  const e = db.prepare('SELECT * FROM exports WHERE id = ?').get(exportId) as Row | undefined;
  if (!e || e.workspace_id !== actor.workspace_id) throw new ApiError(404, 'not_found', 'export not found');
  if (actor.role === 'distributor' && e.kind !== 'final') {
    throw new ApiError(403, 'forbidden_role', 'distributors may only access approved exports');
  }
  return e;
}

export function getExportArtifactPath(db: DB, actor: Actor, exportId: string): string {
  const e = getExport(db, actor, exportId);
  return e.artifact_path as string;
}
