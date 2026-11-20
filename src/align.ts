import { id, now, sha256 } from './util/hash.ts';
import { ApiError, requireSameWorkspace, type Actor } from './http.ts';
import type { DB } from './db.ts';

export interface CueRow {
  id: string;
  cue_id: string | null;
  seq: number;
  start_ms: number;
  end_ms: number;
  source_text: string;
  source_hash: string;
  approved_target_text: string | null;
}

const CARRY_CONFIDENCE = 0.8; // below this an approved target may not be carried (INV-02)

interface Candidate { cue: CueRow; evidence: 'id' | 'text' | 'time'; score: number }

function overlapMs(a: CueRow, b: CueRow): number {
  return Math.max(0, Math.min(a.end_ms, b.end_ms) - Math.max(a.start_ms, b.start_ms));
}

/**
 * Map cues of oldRevision onto newRevision. Group kinds: unchanged, retime,
 * edit, insertion, deletion, ambiguous. Ambiguous or low-confidence groups are
 * marked needs_review and never carry an approved target forward.
 */
export function computeAlignment(db: DB, oldRevisionId: string, newRevisionId: string): void {
  const oldRev = db.prepare('SELECT id, edition_id, workspace_id FROM revisions WHERE id = ?').get(oldRevisionId) as
    { id: string; edition_id: string; workspace_id: string } | undefined;
  const newRev = db.prepare('SELECT id, edition_id, workspace_id FROM revisions WHERE id = ?').get(newRevisionId) as
    { id: string; edition_id: string; workspace_id: string } | undefined;
  if (!oldRev || !newRev) throw new ApiError(404, 'not_found', 'revision not found');
  if (oldRev.edition_id !== newRev.edition_id) throw new ApiError(400, 'cross_edition', 'revisions belong to different editions');

  const oldCues = db.prepare('SELECT * FROM cues WHERE revision_id = ? ORDER BY seq').all(oldRevisionId) as CueRow[];
  const newCues = db.prepare('SELECT * FROM cues WHERE revision_id = ? ORDER BY seq').all(newRevisionId) as CueRow[];

  db.prepare('DELETE FROM alignments WHERE new_revision_id = ?').run(newRevisionId);

  const usedOld = new Set<string>();
  const groups: {
    groupKey: string; oldIds: string[]; newIds: string[]; kind: string;
    reason: string; confidence: number; status: string;
  }[] = [];
  let g = 0;
  const nextKey = () => `g${++g}`;

  // Phase A: cue_id or identical-text candidates.
  const byId = new Map(oldCues.filter((c) => c.cue_id).map((c) => [c.cue_id!, c]));
  const byHash = new Map<string, CueRow[]>();
  for (const c of oldCues) {
    const list = byHash.get(c.source_hash) ?? [];
    list.push(c);
    byHash.set(c.source_hash, list);
  }

  const pendingNew: CueRow[] = [];
  for (const nc of newCues) {
    const candidates: Candidate[] = [];
    if (nc.cue_id && byId.has(nc.cue_id) && !usedOld.has(byId.get(nc.cue_id)!.id)) {
      candidates.push({ cue: byId.get(nc.cue_id)!, evidence: 'id', score: 1 });
    }
    for (const oc of byHash.get(nc.source_hash) ?? []) {
      if (!usedOld.has(oc.id) && !candidates.some((c) => c.cue.id === oc.id)) {
        candidates.push({ cue: oc, evidence: 'text', score: 0.9 });
      }
    }
    if (candidates.length === 1) {
      const oc = candidates[0].cue;
      usedOld.add(oc.id);
      groups.push(classifyPair(nextKey(), oc, nc, `matched by ${candidates[0].evidence}`));
    } else if (candidates.length > 1) {
      // Repeated identical lines without a disambiguating cue id (T-004).
      for (const c of candidates) usedOld.add(c.cue.id);
      groups.push({
        groupKey: nextKey(), oldIds: candidates.map((c) => c.cue.id), newIds: [nc.id],
        kind: 'ambiguous', reason: `${candidates.length} identical candidate lines; manual mapping required`,
        confidence: 0.3, status: 'needs_review',
      });
    } else {
      pendingNew.push(nc);
    }
  }

  // Phase B: monotonic time-overlap evidence for the remainder.
  for (const nc of pendingNew) {
    const scored = oldCues
      .filter((oc) => !usedOld.has(oc.id))
      .map((oc) => {
        const ov = overlapMs(oc, nc);
        const score = ov / Math.min(oc.end_ms - oc.start_ms, nc.end_ms - nc.start_ms || 1);
        return { cue: oc, score };
      })
      .filter((s) => s.score > 0.15)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 0) {
      groups.push({
        groupKey: nextKey(), oldIds: [], newIds: [nc.id], kind: 'insertion',
        reason: 'no old cue overlaps; new text inserted', confidence: 0.9, status: 'auto',
      });
      continue;
    }
    const tied = scored.filter((s) => Math.abs(s.score - scored[0].score) < 0.05);
    if (tied.length > 1) {
      for (const s of tied) usedOld.add(s.cue.id);
      groups.push({
        groupKey: nextKey(), oldIds: tied.map((s) => s.cue.id), newIds: [nc.id],
        kind: 'ambiguous', reason: `${tied.length} overlapping old cues tie; manual mapping required`,
        confidence: scored[0].score * 0.6, status: 'needs_review',
      });
      continue;
    }
    const oc = scored[0].cue;
    usedOld.add(oc.id);
    const pair = classifyPair(nextKey(), oc, nc, `matched by time overlap ${(scored[0].score * 100).toFixed(0)}%`);
    pair.confidence = Math.min(pair.confidence, 0.5 + scored[0].score * 0.4);
    if (pair.confidence < CARRY_CONFIDENCE && pair.kind !== 'edit') {
      pair.status = 'needs_review';
      pair.kind = 'ambiguous';
      pair.reason += ' (below carry confidence)';
    }
    groups.push(pair);
  }

  for (const oc of oldCues) {
    if (!usedOld.has(oc.id)) {
      groups.push({
        groupKey: nextKey(), oldIds: [oc.id], newIds: [], kind: 'deletion',
        reason: 'old cue has no replacement', confidence: 0.9, status: 'auto',
      });
    }
  }

  const insert = db.prepare(`INSERT INTO alignments(id,workspace_id,edition_id,old_revision_id,new_revision_id,
    group_key,old_cue_ids,new_cue_ids,kind,reason,confidence,resolver,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const ts = now();
  for (const grp of groups) {
    insert.run(id('aln'), newRev.workspace_id, newRev.edition_id, oldRevisionId, newRevisionId,
      grp.groupKey, JSON.stringify(grp.oldIds), JSON.stringify(grp.newIds),
      grp.kind, grp.reason, grp.confidence, null, grp.status, ts);
  }

  // Carry approved targets onto unchanged/retimed cues only (INV-02).
  const newById = new Map(newCues.map((c) => [c.id, c]));
  const oldById = new Map(oldCues.map((c) => [c.id, c]));
  const setTarget = db.prepare('UPDATE cues SET approved_target_text = ? WHERE id = ?');
  for (const grp of groups) {
    if (grp.status === 'needs_review') continue;
    if (grp.kind !== 'unchanged' && grp.kind !== 'retime') continue;
    if (grp.confidence < CARRY_CONFIDENCE) continue;
    for (const nid of grp.newIds) {
      const oc = oldById.get(grp.oldIds[0]);
      const nc = newById.get(nid);
      if (oc?.approved_target_text && nc) setTarget.run(oc.approved_target_text, nc.id);
    }
  }
}

function classifyPair(groupKey: string, oc: CueRow, nc: CueRow, evidence: string) {
  const sameText = oc.source_hash === nc.source_hash;
  const sameTime = oc.start_ms === nc.start_ms && oc.end_ms === nc.end_ms;
  let kind: string;
  let confidence: number;
  if (sameText && sameTime) { kind = 'unchanged'; confidence = 1; }
  else if (sameText) { kind = 'retime'; confidence = 0.95; }
  else { kind = 'edit'; confidence = evidence.includes('id') ? 0.9 : 0.8; }
  return {
    groupKey, oldIds: [oc.id], newIds: [nc.id], kind,
    reason: `${kind}: ${evidence}`, confidence, status: 'auto',
  };
}

export function listAlignment(db: DB, newRevisionId: string) {
  return (db.prepare('SELECT * FROM alignments WHERE new_revision_id = ? ORDER BY group_key')
    .all(newRevisionId) as Record<string, unknown>[]).map((row) => ({
      ...row,
      old_cue_ids: JSON.parse(row.old_cue_ids as string),
      new_cue_ids: JSON.parse(row.new_cue_ids as string),
    }));
}

export function resolveAlignmentGroup(
  db: DB, actor: Actor, newRevisionId: string, groupKey: string, body: Record<string, unknown>,
) {
  const grp = db.prepare('SELECT * FROM alignments WHERE new_revision_id = ? AND group_key = ?')
    .get(newRevisionId, groupKey) as Record<string, unknown> | undefined;
  if (!grp) throw new ApiError(404, 'not_found', 'alignment group not found');
  requireSameWorkspace(actor, grp.workspace_id as string);

  const kind = String(body.kind ?? '');
  if (!['unchanged', 'retime', 'edit', 'insertion', 'deletion'].includes(kind)) {
    throw new ApiError(400, 'invalid_kind', 'resolved kind must be a concrete change kind');
  }
  const oldIds = (body.oldCueIds as string[] | undefined) ?? JSON.parse(grp.old_cue_ids as string);
  const newIds = (body.newCueIds as string[] | undefined) ?? JSON.parse(grp.new_cue_ids as string);
  const reason = String(body.reason ?? grp.reason);

  db.prepare(`UPDATE alignments SET kind = ?, old_cue_ids = ?, new_cue_ids = ?, reason = ?,
    confidence = 1, resolver = ?, status = 'resolved' WHERE id = ?`)
    .run(kind, JSON.stringify(oldIds), JSON.stringify(newIds), `manual: ${reason}`, actor.id, grp.id);

  // A resolved unchanged/retime mapping may now carry the approved target.
  if (kind === 'unchanged' || kind === 'retime') {
    const oc = oldIds[0]
      ? db.prepare('SELECT approved_target_text FROM cues WHERE id = ?').get(oldIds[0]) as { approved_target_text: string | null } | undefined
      : undefined;
    if (oc?.approved_target_text) {
      const set = db.prepare('UPDATE cues SET approved_target_text = ? WHERE id = ?');
      for (const nid of newIds) set.run(oc.approved_target_text, nid);
    }
  }

  // Dependent plans are stale once the mapping they priced has changed.
  db.prepare("UPDATE repair_plans SET status = 'stale', version = version + 1 WHERE new_revision_id = ? AND status IN ('ready','cap_exceeded')")
    .run(newRevisionId);

  return { groupKey, status: 'resolved', kind };
}
