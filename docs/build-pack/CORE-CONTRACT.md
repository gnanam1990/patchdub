# PatchDub · acceptance contract

### FR-01 — Revision and subtitle import

Create workspace-scoped episode storage, bounded WebVTT parsing, original hashes and previous-target associations. Preserve parsed cue text and millisecond timestamps.

### INV-01 — Revision and subtitle import

An upload retry with the same identity binds to one revision.

### FR-02 — Alignment and repair planning

Map old and new cues, record reasons and groups, distinguish retime, edit, insertion and deletion, and offer a manual disambiguation action.

### INV-02 — Alignment and repair planning

A low-confidence match cannot silently carry forward an approved target.

### FR-03 — Scoped purchase and translation worker

Price the full approved repair window, reserve the cap atomically, dispatch through the chosen Kite-compatible seller and record the rail and independently observed receipt. Keep a local adapter for deterministic contract testing.

### INV-03 — Scoped purchase and translation worker

A quote or stale plan cannot authorize a new or more expensive order.

### FR-04 — Terminology and timing checks

Validate numbers, placeholders and glossary terms against the pinned revision. Check cue bounds, unintended overlap and display-time limits. Emit per-cue findings and source offsets.

### INV-04 — Terminology and timing checks

A translator response alone cannot clear an unresolved required-term finding.

### FR-05 — Reviewer workspace

Build accessible timeline navigation, editable target rows, reasoned resolve/reject actions, cost indicators and version-aware saves.

### INV-05 — Reviewer workspace

An approval belongs to one reviewer, one digest and one workspace.

### FR-06 — Export and billable intervals

Serialize valid UTF-8 WebVTT, ordered cues and a manifest with parent hashes, findings and accepted usage. Calculate billable changed seconds as an interval union.

### INV-06 — Export and billable intervals

Export preserves unaffected approved target text; overlapping paid intervals count once.

### FR-07 — Recovery and studio acceptance

Add an operator queue for unknown charges, artifact retention and a replayable studio demonstration through upload, review, purchase and export.

### INV-07 — Recovery and studio acceptance

Restart and replay cannot double-buy a translation or expose another studio's subtitles.

### NFR-01 — Replayable evidence

A reviewer can reproduce the outcome from the exact input revision, actor scope, persisted decision and redacted evidence reference after a process restart.
