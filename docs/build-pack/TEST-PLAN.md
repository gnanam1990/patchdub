# PatchDub · Test plan

Every test begins NOT_RUN. [Registry](requirements.json) links each test to one module and its requirement. Run fast domain tests first, then real database/worker integration and normal browser entry points. External integration evidence states its environment and provider.

## Reference end-to-end acceptance

Use six four-second cues, C1–C6, on a 24-second track. C2 and C5 change text. C4 moves to 12.5–15.5 s without a text change. Order translations for the two changed cues at an agreed price of 2 minor units per cue and a cap of 4. Exactly two translations are requested for total 4, C4 reuses approved Tamil and gets a timing check, and the union of paid updated intervals is 8 seconds. A required term missing in C5 holds export until the language reviewer approves its corrected digest. At a cap of 3, dispatch zero orders for this all-or-none plan.

Run from a clean checkout. Capture the action through the UI or supported API, restart at an uncertain boundary, inspect the recovered record with a second authorized session and export the allowed outcome. Verify a different tenant cannot access it. Exercise the chosen provider against an authorized sandbox/test environment; a local boundary emulator is suitable for deterministic fault injection. Qualify each result by environment.

## Module tests

### T-001 — Revision and subtitle import • expected behavior

Status: NOT_RUN

Import the six-cue track twice; retrieve six cues and one revision ID.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-002 — Revision and subtitle import • failure boundary

Status: NOT_RUN

A cue ending before its start returns a line-level validation error and persists no active revision.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-003 — Alignment and repair planning • expected behavior

Status: NOT_RUN

Classify C2 and C5 as edits and C4 as retime with zero translation units for C4.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-004 — Alignment and repair planning • failure boundary

Status: NOT_RUN

Two identical adjacent lines crossing a cut open a mapping review before the quote can be approved.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-005 — Scoped purchase and translation worker • expected behavior

Status: NOT_RUN

The six-cue fixture reserves and records four minor units over two items.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-006 — Scoped purchase and translation worker • failure boundary

Status: NOT_RUN

A cap of three creates zero dispatched orders, even with two concurrent approval clicks.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-007 — Terminology and timing checks • expected behavior

Status: NOT_RUN

Correcting the missing approved Tamil term in C5 resolves that finding at the new variant hash.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-008 — Terminology and timing checks • failure boundary

Status: NOT_RUN

A replacement that drops a source placeholder remains blocked even when all dictionary terms pass.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-009 — Reviewer workspace • expected behavior

Status: NOT_RUN

A keyboard-only reviewer resolves C5, follows the next issue, and approves the corrected version.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-010 — Reviewer workspace • failure boundary

Status: NOT_RUN

Two browser tabs reviewing different C5 variants produce a stale-write response for the older tab.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-011 — Export and billable intervals • expected behavior

Status: NOT_RUN

Download and reparse the final export; C4 has its revised timing, and accepted paid duration is eight seconds.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-012 — Export and billable intervals • failure boundary

Status: NOT_RUN

An active unresolved timing or glossary issue blocks final export while preserving access to the labeled draft.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-013 — Recovery and studio acceptance • expected behavior

Status: NOT_RUN

Restart after the provider accepts an order and attach the original receipt on reconciliation.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-014 — Recovery and studio acceptance • failure boundary

Status: NOT_RUN

When the seller cannot resolve an uncertain payment, keep the item pending and do not auto-repurchase.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.
