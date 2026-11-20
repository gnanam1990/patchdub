import { id, now, sha256 } from './util/hash.ts';
import { ApiError, int, str, type Actor } from './http.ts';
import { tx, type DB } from './db.ts';
import { listAlignment } from './align.ts';
import { runChecksForPatch } from './checks.ts';

const DEFAULT_UNIT_PRICE_MINOR = 2;
const TRANSLATE_KINDS = new Set(['edit', 'insertion']);

interface RevRow { [k: string]: unknown }

export function createRepairPlan(db: DB, actor: Actor, rev: RevRow, body: Record<string, unknown>) {
  if (rev.kind !== 'source') throw new ApiError(400, 'invalid_revision', 'repair plans target a source revision');
  if (!rev.parent_id) throw new ApiError(400, 'no_parent', 'no previous source revision to align against');

  const groups = listAlignment(db, rev.id as string);
  if (groups.length === 0) {
    throw new ApiError(409, 'no_alignment', 'compute alignment before planning');
  }

  const unitPrice = body.unitPriceMinor !== undefined ? int(body, 'unitPriceMinor') : DEFAULT_UNIT_PRICE_MINOR;
  const cap = int(body, 'capMinor');
  const glossaryId = str(body, 'glossaryId') || null;
  let glossaryDigestVal: string | null = null;
  if (glossaryId) {
    const g = db.prepare('SELECT digest, workspace_id FROM glossaries WHERE id = ?').get(glossaryId) as
      { digest: string; workspace_id: string } | undefined;
    if (!g || g.workspace_id !== actor.workspace_id) throw new ApiError(404, 'not_found', 'glossary not found');
    glossaryDigestVal = g.digest;
  }

  const items = groups
    .filter((gr) => TRANSLATE_KINDS.has(gr.kind as string) || gr.kind === 'retime')
    .flatMap((gr) => (gr.new_cue_ids as string[]).map((cueId) => ({
      groupKey: gr.group_key as string,
      newCueId: cueId,
      kind: gr.kind as string,
      price: TRANSLATE_KINDS.has(gr.kind as string) ? unitPrice : 0,
    })));

  return tx(db, () => {
    const planId = id('plan');
    const total = items.reduce((s, i) => s + i.price, 0);
    const unresolved = groups.filter((gr) => gr.status === 'needs_review').length;
    db.prepare(`INSERT INTO repair_plans(id,workspace_id,edition_id,new_revision_id,glossary_id,glossary_digest,
      unit_price_minor,total_minor,cap_minor,version,status,created_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(planId, actor.workspace_id, rev.edition_id, rev.id, glossaryId, glossaryDigestVal,
        unitPrice, total, cap, 1, 'ready', actor.id, now());
    const ins = db.prepare('INSERT INTO plan_items(id,plan_id,group_key,new_cue_id,kind,price_minor,seq) VALUES (?,?,?,?,?,?,?)');
    items.forEach((it, i) => ins.run(id('pi'), planId, it.groupKey, it.newCueId, it.kind, it.price, i));
    return {
      id: planId, revision: rev.id, items: items.map((it) => ({
        groupKey: it.groupKey, newCueId: it.newCueId, kind: it.kind, priceMinor: it.price,
      })),
      unitPriceMinor: unitPrice, totalMinor: total, capMinor: cap,
      glossaryDigest: glossaryDigestVal, unresolvedGroups: unresolved, status: 'ready',
    };
  });
}

export function getPlan(db: DB, actor: Actor, planId: string) {
  const plan = db.prepare('SELECT * FROM repair_plans WHERE id = ?').get(planId) as RevRow | undefined;
  if (!plan || plan.workspace_id !== actor.workspace_id) throw new ApiError(404, 'not_found', 'plan not found');
  const items = db.prepare('SELECT * FROM plan_items WHERE plan_id = ? ORDER BY seq').all(planId);
  const patches = db.prepare(
    'SELECT id, group_key, new_cue_id, change_kind, status, variant_hash, approved_digest FROM patches WHERE plan_id = ?',
  ).all(planId);
  const purchases = db.prepare(
    'SELECT id, patch_id, provider_id, quote_minor, amount_minor, rail, external_ref, status FROM purchases WHERE plan_id = ?',
  ).all(planId);
  return { plan, items, patches, purchases };
}

export function listPlansForRevision(db: DB, revisionId: string) {
  return db.prepare('SELECT * FROM repair_plans WHERE new_revision_id = ? ORDER BY created_at').all(revisionId);
}

/**
 * Approve a bounded quote: reserves the cap and creates patches, reserved
 * purchases and outbox dispatch jobs in one transaction. All-or-none when the
 * quote exceeds the cap. Idempotent on operations.id (the client key).
 */
export function approvePlan(db: DB, actor: Actor, planId: string, body: Record<string, unknown>) {
  const idemKey = str(body, 'idempotencyKey');
  if (!idemKey) throw new ApiError(400, 'missing_field', 'idempotencyKey is required');
  const expectedVersion = body.expectedVersion !== undefined ? int(body, 'expectedVersion') : null;
  const requestHash = sha256(JSON.stringify({ planId, expectedVersion, actor: actor.id }));

  // Idempotent replay: same key + same payload returns the stored outcome.
  const prior = db.prepare('SELECT * FROM operations WHERE id = ?').get(idemKey) as RevRow | undefined;
  if (prior) {
    if (prior.request_hash !== requestHash) {
      throw new ApiError(409, 'idempotency_conflict', 'key reused with a different payload');
    }
    return { replayed: true, ...(JSON.parse(prior.response as string) as object) };
  }

  return tx(db, () => {
    const plan = db.prepare('SELECT * FROM repair_plans WHERE id = ?').get(planId) as RevRow | undefined;
    if (!plan || plan.workspace_id !== actor.workspace_id) throw new ApiError(404, 'not_found', 'plan not found');
    if (plan.status !== 'ready') {
      throw new ApiError(409, 'plan_not_approvable', `plan status is ${plan.status}`);
    }
    // INV-03: a stale plan cannot authorize work.
    if (expectedVersion !== null && expectedVersion !== plan.version) {
      throw new ApiError(409, 'stale_plan', `plan version is ${plan.version}, expected ${expectedVersion}`);
    }
    const unresolved = db.prepare(
      "SELECT COUNT(*) n FROM alignments WHERE new_revision_id = ? AND status = 'needs_review'",
    ).get(plan.new_revision_id as string) as { n: number };
    if (unresolved.n > 0) {
      throw new ApiError(409, 'alignment_unresolved',
        `${unresolved.n} mapping group(s) need review before the quote can be approved`);
    }

    // All-or-none: quote above cap reserves nothing and dispatches nothing.
    if ((plan.total_minor as number) > (plan.cap_minor as number)) {
      db.prepare("UPDATE repair_plans SET status = 'cap_exceeded', version = version + 1 WHERE id = ?").run(planId);
      const outcome = { planId, status: 'cap_exceeded', dispatched: 0, reservedMinor: 0, operationId: idemKey };
      recordOperation(db, idemKey, actor, 'plan.approve', requestHash, 'cap_exceeded', planId, outcome);
      return outcome;
    }

    const items = db.prepare('SELECT * FROM plan_items WHERE plan_id = ? ORDER BY seq').all(planId) as RevRow[];
    const ts = now();
    let dispatched = 0;
    for (const item of items) {
      const cue = db.prepare('SELECT * FROM cues WHERE id = ?').get(item.new_cue_id as string) as RevRow | undefined;
      if (!cue) throw new ApiError(500, 'internal', 'plan item references missing cue');
      const context = adjacentSource(db, cue.revision_id as string, cue.seq as number);
      const patchId = id('pch');
      if (TRANSLATE_KINDS.has(item.kind as string)) {
        db.prepare(`INSERT INTO patches(id,workspace_id,edition_id,plan_id,group_key,new_cue_id,change_kind,
          source_text,context,glossary_digest,expected_version,status,start_ms,end_ms,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(patchId, actor.workspace_id, plan.edition_id, planId, item.group_key, cue.id,
            item.kind, cue.source_text, JSON.stringify(context), plan.glossary_digest,
            1, 'pending', cue.start_ms, cue.end_ms, ts, ts);
        const orderKey = [
          'local-seller', plan.glossary_digest ?? 'nogloss', item.group_key,
          plan.new_revision_id, cue.id,
        ].join('|');
        const purchaseId = id('pur');
        db.prepare(`INSERT INTO purchases(id,workspace_id,patch_id,plan_id,provider_id,order_key,quote_minor,
          token,decimals,rail,external_ref,idempotency_key,status,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(purchaseId, actor.workspace_id, patchId, planId, 'local-seller', orderKey,
            item.price_minor, 'CREDITS', 0, 'local-emulator', null,
            `${idemKey}:${item.group_key}`, 'reserved', ts, ts);
        db.prepare('INSERT INTO outbox(id,workspace_id,operation_id,kind,payload,status,attempts,created_at) VALUES (?,?,?,?,?,?,0,?)')
          .run(id('obx'), actor.workspace_id, idemKey, 'dispatch_order',
            JSON.stringify({ purchaseId }), 'pending', ts);
        dispatched++;
      } else {
        // Retime: reuse the approved target, run the timing check (FR-02/T-003).
        db.prepare(`INSERT INTO patches(id,workspace_id,edition_id,plan_id,group_key,new_cue_id,change_kind,
          source_text,context,glossary_digest,expected_version,status,variant_text,variant_hash,
          approved_by,approved_digest,start_ms,end_ms,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(patchId, actor.workspace_id, plan.edition_id, planId, item.group_key, cue.id,
            'retime', cue.source_text, JSON.stringify(context), plan.glossary_digest,
            1, 'reuse_checked', cue.approved_target_text, null, null, null,
            cue.start_ms, cue.end_ms, ts, ts);
        if (cue.approved_target_text) {
          db.prepare('UPDATE patches SET variant_hash = ? WHERE id = ?')
            .run(sha256(String(cue.approved_target_text).normalize('NFC').trim()), patchId);
        }
        runChecksForPatch(db, patchId);
        markFlaggedIfFindings(db, patchId);
      }
    }
    db.prepare("UPDATE repair_plans SET status = 'approved', version = version + 1 WHERE id = ?").run(planId);
    const outcome = {
      planId, status: 'approved', dispatched, reservedMinor: plan.total_minor, operationId: idemKey,
    };
    recordOperation(db, idemKey, actor, 'plan.approve', requestHash, 'approved', planId, outcome);
    return outcome;
  });
}

function recordOperation(
  db: DB, key: string, actor: Actor, kind: string, requestHash: string,
  status: string, resourceId: string, response: unknown,
) {
  db.prepare(`INSERT INTO operations(id,workspace_id,actor_id,kind,request_hash,status,resource_id,response,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(key, actor.workspace_id, actor.id, kind, requestHash, status, resourceId,
      JSON.stringify(response), now());
}

function adjacentSource(db: DB, revisionId: string, seq: number): { seq: number; text: string }[] {
  return db.prepare(
    'SELECT seq, source_text AS text FROM cues WHERE revision_id = ? AND seq BETWEEN ? AND ? AND seq != ? ORDER BY seq',
  ).all(revisionId, seq - 1, seq + 1, seq) as { seq: number; text: string }[];
}

function markFlaggedIfFindings(db: DB, patchId: string): void {
  const open = db.prepare("SELECT COUNT(*) n FROM findings WHERE patch_id = ? AND status = 'open'")
    .get(patchId) as { n: number };
  if (open.n > 0) {
    db.prepare("UPDATE patches SET status = 'flagged', updated_at = ? WHERE id = ? AND status != 'approved'")
      .run(now(), patchId);
  }
}
