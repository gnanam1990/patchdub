import { id, now, variantDigest } from './util/hash.ts';
import { ApiError, str, type Actor } from './http.ts';
import { tx, type DB } from './db.ts';
import { runChecksForPatch } from './checks.ts';

interface PRow { [k: string]: unknown }

function loadPatch(db: DB, actor: Actor, patchId: string): PRow {
  const p = db.prepare('SELECT * FROM patches WHERE id = ?').get(patchId) as PRow | undefined;
  if (!p || p.workspace_id !== actor.workspace_id) throw new ApiError(404, 'not_found', 'patch not found');
  return p;
}

function checkIfMatch(patch: PRow, ifMatch: string | undefined): void {
  if (ifMatch === undefined) {
    throw new ApiError(428, 'version_required', 'If-Match header with the patch version is required');
  }
  const want = Number(ifMatch.replaceAll('"', ''));
  if (!Number.isInteger(want) || want !== patch.expected_version) {
    throw new ApiError(409, 'stale_write',
      `patch version is ${patch.expected_version}; re-read and retry`);
  }
}

export function getPatch(db: DB, actor: Actor, patchId: string) {
  const patch = loadPatch(db, actor, patchId);
  const findings = db.prepare('SELECT * FROM findings WHERE patch_id = ? ORDER BY created_at').all(patchId);
  const reviews = db.prepare(
    'SELECT id, variant_hash, reviewer_id, verdict, reason, created_at FROM reviews WHERE patch_id = ? ORDER BY created_at',
  ).all(patchId);
  const purchase = db.prepare(
    'SELECT id, provider_id, quote_minor, amount_minor, rail, external_ref, status FROM purchases WHERE patch_id = ?',
  ).get(patchId);
  const cue = db.prepare('SELECT cue_id, seq, start_ms, end_ms, revision_id FROM cues WHERE id = ?')
    .get(patch.new_cue_id as string);
  return { patch, cue, findings, reviews, purchase };
}

export function listPatchesForEdition(db: DB, editionId: string) {
  return (db.prepare(
    `SELECT p.id, p.group_key, p.new_cue_id, p.change_kind, p.status, p.expected_version,
            p.variant_text IS NOT NULL AS has_variant, p.variant_hash, p.approved_digest,
            p.start_ms, p.end_ms, p.source_text,
            COALESCE((SELECT pi.price_minor FROM plan_items pi
              WHERE pi.plan_id = p.plan_id AND pi.new_cue_id = p.new_cue_id), 0) AS price_minor,
            (SELECT c.cue_id FROM cues c WHERE c.id = p.new_cue_id) AS cue_label,
            (SELECT COUNT(*) FROM findings f WHERE f.patch_id = p.id AND f.status = 'open') AS open_findings
     FROM patches p WHERE p.edition_id = ? ORDER BY p.start_ms`,
  ).all(editionId));
}

/** Reviewer edits the target variant. Version-aware (If-Match); reruns checks. */
export function editPatchVariant(
  db: DB, actor: Actor, patchId: string, body: Record<string, unknown>, ifMatch?: string,
) {
  return tx(db, () => {
    const patch = loadPatch(db, actor, patchId);
    checkIfMatch(patch, ifMatch);
    if (!['translated', 'flagged', 'dispatched'].includes(patch.status as string)) {
      throw new ApiError(409, 'not_editable', `patch status ${patch.status} is not editable`);
    }
    const text = str(body, 'variantText');
    if (!text) throw new ApiError(400, 'missing_field', 'variantText is required');
    const digest = variantDigest(text);
    const approved = patch.approved_digest === digest ? patch.approved_by : null;
    db.prepare(`UPDATE patches SET variant_text = ?, variant_hash = ?, expected_version = expected_version + 1,
      approved_by = ?, approved_digest = ?, status = CASE WHEN status = 'flagged' THEN 'translated' ELSE status END,
      updated_at = ? WHERE id = ?`)
      .run(text, digest, approved, approved ? digest : null, now(), patchId);
    runChecksForPatch(db, patchId);
    const after = db.prepare('SELECT status, expected_version, variant_hash FROM patches WHERE id = ?')
      .get(patchId) as PRow;
    return {
      id: patchId, status: after.status, expected_version: after.expected_version,
      variant_hash: after.variant_hash,
    };
  });
}

/**
 * Reviewer approves or rejects a patch. The verdict is bound to the reviewer,
 * the current variant digest and the workspace (INV-05). Approval requires all
 * findings resolved at the approved digest.
 */
export function reviewPatch(
  db: DB, actor: Actor, patchId: string, body: Record<string, unknown>, ifMatch?: string,
) {
  return tx(db, () => {
    const patch = loadPatch(db, actor, patchId);
    checkIfMatch(patch, ifMatch);
    const verdict = str(body, 'verdict');
    if (verdict !== 'approve' && verdict !== 'reject') {
      throw new ApiError(400, 'invalid_verdict', 'verdict must be approve or reject');
    }
    if (verdict === 'reject' && !str(body, 'reason')) {
      throw new ApiError(400, 'reason_required', 'a reason is required to reject');
    }
    const digest = str(body, 'digest');
    if (digest !== patch.variant_hash) {
      throw new ApiError(409, 'digest_mismatch',
        'approval digest does not match the current variant digest');
    }
    if (!patch.variant_hash) throw new ApiError(409, 'no_variant', 'no variant to review');

    if (verdict === 'approve') {
      const open = db.prepare("SELECT COUNT(*) n FROM findings WHERE patch_id = ? AND status = 'open'")
        .get(patchId) as { n: number };
      if (open.n > 0) {
        throw new ApiError(409, 'findings_open',
          `${open.n} finding(s) still open; resolve them before approving`);
      }
    }

    db.prepare('INSERT INTO reviews(id,workspace_id,patch_id,variant_hash,reviewer_id,verdict,reason,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id('rvw'), actor.workspace_id, patchId, digest, actor.id, verdict,
        str(body, 'reason'), now());
    const nextStatus = verdict === 'approve' ? 'approved' : 'rejected';
    db.prepare(`UPDATE patches SET status = ?, approved_by = ?, approved_digest = ?,
      expected_version = expected_version + 1, updated_at = ? WHERE id = ?`)
      .run(nextStatus, verdict === 'approve' ? actor.id : null,
        verdict === 'approve' ? digest : null, now(), patchId);
    return { id: patchId, status: nextStatus, approved_digest: verdict === 'approve' ? digest : null };
  });
}
