import { id, now, variantDigest } from './util/hash.ts';
import type { DB } from './db.ts';

// Timing/display limits (configurable per workspace later).
export const MIN_DURATION_MS = 800;
export const MAX_DURATION_MS = 12_000;
export const MAX_CPS = 40;

const NUMBER_RE = /\d+(?:[.,]\d+)*/g;
const PLACEHOLDER_RE = /\{[^{}]*\}|%[sdfox]|%\d+\$[sdfox]|<\/?[a-zA-Z][^>]*>/g;

interface PatchRow {
  id: string; workspace_id: string; new_cue_id: string; change_kind: string;
  source_text: string; glossary_digest: string | null; variant_text: string | null;
  variant_hash: string | null; start_ms: number; end_ms: number; plan_id: string;
}

interface FindingDraft {
  kind: string; code: string; message: string; sourceOffsetMs: number | null;
}

function tokens(text: string, re: RegExp): string[] {
  return (text.match(re) ?? []).sort();
}

function glossaryTermsForPatch(db: DB, patch: PatchRow): { source: string; target: string; required: boolean }[] {
  if (!patch.glossary_digest) return [];
  const plan = db.prepare('SELECT glossary_id FROM repair_plans WHERE id = ?').get(patch.plan_id) as
    { glossary_id: string | null } | undefined;
  if (!plan?.glossary_id) return [];
  const g = db.prepare('SELECT terms FROM glossaries WHERE id = ?').get(plan.glossary_id) as
    { terms: string } | undefined;
  return g ? JSON.parse(g.terms) : [];
}

/**
 * Evaluate terminology and timing rules for a patch's current variant. Open
 * findings that no longer fire are resolved at the current variant digest;
 * findings that still fire stay open. A translator response alone can never
 * clear a required-term finding (INV-04): only a persisted variant whose
 * digest passes the check resolves it.
 */
export function runChecksForPatch(db: DB, patchId: string): void {
  const patch = db.prepare('SELECT * FROM patches WHERE id = ?').get(patchId) as PatchRow | undefined;
  if (!patch) return;
  const cue = db.prepare('SELECT id, revision_id, seq, start_ms, end_ms, cue_id FROM cues WHERE id = ?')
    .get(patch.new_cue_id) as { id: string; revision_id: string; seq: number; start_ms: number; end_ms: number; cue_id: string | null } | undefined;
  if (!cue) return;

  const source = patch.source_text;
  const variant = patch.variant_text ?? '';
  const digest = variant ? variantDigest(variant) : null;
  const drafts: FindingDraft[] = [];

  if (variant) {
    // Numbers present in the source must all appear in the target.
    const srcNums = tokens(source, NUMBER_RE);
    const tgtNums = tokens(variant, NUMBER_RE);
    const missingNums = srcNums.filter((n, i) => !tgtNums.includes(n) || tgtNums.indexOf(n) < i);
    if (srcNums.join(',') !== tgtNums.join(',')) {
      drafts.push({
        kind: 'numbers', code: 'number_mismatch',
        message: `source numbers [${srcNums.join(', ')}] differ from target [${tgtNums.join(', ')}]`,
        sourceOffsetMs: patch.start_ms,
      });
    } else if (missingNums.length) {
      drafts.push({
        kind: 'numbers', code: 'number_missing', message: `missing numbers: ${missingNums.join(', ')}`,
        sourceOffsetMs: patch.start_ms,
      });
    }

    // Placeholders in the source must all survive into the target.
    const srcPh = tokens(source, PLACEHOLDER_RE);
    const tgtPh = tokens(variant, PLACEHOLDER_RE);
    const missingPh = srcPh.filter((p) => !tgtPh.includes(p));
    if (missingPh.length) {
      drafts.push({
        kind: 'placeholder', code: 'placeholder_dropped',
        message: `target drops source placeholder(s): ${missingPh.join(', ')}`,
        sourceOffsetMs: patch.start_ms,
      });
    }

    // Required glossary terms: source term present -> target term required.
    for (const term of glossaryTermsForPatch(db, patch)) {
      if (term.required && source.includes(term.source) && !variant.includes(term.target)) {
        drafts.push({
          kind: 'required_term', code: 'required_term_missing',
          message: `required term "${term.source}" must be translated as "${term.target}"`,
          sourceOffsetMs: patch.start_ms,
        });
      }
    }
  }

  // Timing checks run on every patched cue (incl. retime reuse).
  const duration = cue.end_ms - cue.start_ms;
  if (duration < MIN_DURATION_MS || duration > MAX_DURATION_MS) {
    drafts.push({
      kind: 'timing', code: 'duration_out_of_bounds',
      message: `cue duration ${duration}ms outside ${MIN_DURATION_MS}-${MAX_DURATION_MS}ms`,
      sourceOffsetMs: cue.start_ms,
    });
  }
  const neighbors = db.prepare(
    'SELECT seq, start_ms, end_ms FROM cues WHERE revision_id = ? AND seq IN (?, ?) ORDER BY seq',
  ).all(cue.revision_id, cue.seq - 1, cue.seq + 1) as { seq: number; start_ms: number; end_ms: number }[];
  for (const n of neighbors) {
    const ov = Math.min(cue.end_ms, n.end_ms) - Math.max(cue.start_ms, n.start_ms);
    if (ov > 0) {
      drafts.push({
        kind: 'timing', code: 'cue_overlap',
        message: `cue overlaps neighbour seq ${n.seq} by ${ov}ms`,
        sourceOffsetMs: Math.max(cue.start_ms, n.start_ms),
      });
    }
  }
  if (variant && duration > 0) {
    const cps = variant.replace(/\s/g, '').length / (duration / 1000);
    if (cps > MAX_CPS) {
      drafts.push({
        kind: 'timing', code: 'display_rate_exceeded',
        message: `${cps.toFixed(1)} chars/s exceeds ${MAX_CPS}`,
        sourceOffsetMs: cue.start_ms,
      });
    }
  }

  // Reconcile: resolve open findings that no longer fire; open new ones.
  const open = db.prepare("SELECT * FROM findings WHERE patch_id = ? AND status = 'open'")
    .all(patchId) as { id: string; code: string }[];
  const firing = new Set(drafts.map((d) => d.code));
  for (const f of open) {
    if (!firing.has(f.code)) {
      db.prepare("UPDATE findings SET status = 'resolved', resolved_digest = ?, resolved_at = ? WHERE id = ?")
        .run(digest, now(), f.id);
    }
  }
  for (const d of drafts) {
    const already = open.find((f) => f.code === d.code);
    if (already) continue;
    db.prepare(`INSERT INTO findings(id,workspace_id,patch_id,cue_id,kind,severity,code,message,
      source_offset_ms,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,'open',?)`)
      .run(id('fnd'), patch.workspace_id, patchId, cue.id, d.kind, 'block', d.code,
        d.message, d.sourceOffsetMs, now());
  }

  // Keep patch status in sync unless already approved.
  const openNow = db.prepare("SELECT COUNT(*) n FROM findings WHERE patch_id = ? AND status = 'open'")
    .get(patchId) as { n: number };
  const cur = db.prepare('SELECT status FROM patches WHERE id = ?').get(patchId) as { status: string };
  if (cur.status !== 'approved' && cur.status !== 'rejected') {
    const next = openNow.n > 0 ? 'flagged'
      : cur.status === 'reuse_checked' ? 'reuse_checked' : 'translated';
    if (next !== cur.status) {
      db.prepare('UPDATE patches SET status = ?, updated_at = ? WHERE id = ?').run(next, now(), patchId);
    }
  }
}

export function openFindingsForEdition(db: DB, editionId: string) {
  return db.prepare(
    "SELECT f.* FROM findings f JOIN patches p ON p.id = f.patch_id WHERE p.edition_id = ? AND f.status = 'open' ORDER BY f.created_at",
  ).all(editionId);
}
