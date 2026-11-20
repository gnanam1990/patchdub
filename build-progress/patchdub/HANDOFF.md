# PatchDub · Session handoff

Initial state: greenfield dedicated repo `patchdub`, branch `devin/patchdub`. Single implementation agent (local SWE-2 High). No prior progress existed. **All seven modules are implemented and verified locally; the documented browser journey is verified in a real headless Chrome (23/23 checks) — see `BROWSER.md`.**

## Stack decision (recorded 2026-11-20)

- Greenfield target; TDD proposes "typed HTTP application, PostgreSQL, supervised worker, role-aware web console".
- No PostgreSQL server runs locally (`pg_isready` → no response) and npm installs are out of scope, so the build uses **Node 22 + TypeScript (native type stripping), node:http, node:sqlite with versioned SQL migrations (`migrations/`), node:test**. Zero external dependencies. `src/db.ts` isolates storage; a Postgres port is a storage swap with identical transaction semantics.
- **Live Kite rail unavailable in this run** (no authority for paid calls; no operator-authorized seller endpoint). The seller boundary is `LocalSellerAdapter` (`src/provider.ts`, rail `local-emulator`), a deterministic emulator whose order book persists in SQLite so receipts survive restarts and can be reconciled by original reference. **Exact missing proof:** an operator-authorized Kite seller endpoint + a settled live receipt on a real rail. All paid outcomes are labeled `local-emulator` and kept separately identifiable in `purchases.rail` and export manifests.
- Console: static accessible UI in `public/` (keyboard review: j/k/e/s/a/x, Esc leaves editor, aria-live announcements, hash-preserved cue selection). Served by the API. Browser-rendered proof captured via `scripts/browser-check.ts` (zero-dep CDP driver; Playwright-cache `chromium_headless_shell-1254`): full producer→reviewer→export journey, 320px keyboard pass, reload persistence, permission/error visibility — 23/23 PASS, evidence in `build-progress/patchdub/evidence/browser/`, runnable record in `BROWSER.md`.

## Status

- Target repository / branch / tested SHA: this checkout, `devin/patchdub`, `acbc75d` (module acceptance + browser journey verified, incl. clean-checkout browser run)
- Module states: M01–M07 accepted (see STATUS.json)
- Completed behavior and evidence:
  - FR-01/INV-01: bounded WebVTT import, sha256 + artifact storage, idempotent retry, line-level errors, tenant scoping — `test/m01-import.test.ts` (T-001, T-002)
  - FR-02/INV-02: alignment classifies unchanged/retime/edit/insertion/deletion, ambiguous groups open review before quote approval, no low-confidence carry-forward — `test/m02-align.test.ts` (T-003, T-004)
  - FR-03/INV-03: atomic cap reservation + patches + reserved purchases + outbox in one tx; all-or-none over cap; idempotent replay; stale-version rejection — `test/m03-purchase.test.ts` (T-005, T-006, INV-03)
  - FR-04/INV-04: number/placeholder/required-term + bounds/overlap/display-rate checks; findings resolve only at a passing variant digest — `test/m04-checks.test.ts` (T-007, T-008)
  - FR-05/INV-05: If-Match versioned edits and digest-bound approve/reject; stale-write 409 — `test/m05-review.test.ts` (T-009, T-010)
  - FR-06/INV-06: gated final vs labeled draft export, manifest (parent hashes, findings, usage, receipts), billable interval union — `test/m06-export.test.ts` (T-011, T-012)
  - FR-07/INV-07: durable dispatch→verify split, restored-DB sweep, operator reconcile by original ref, no repurchase; `scripts/demo.ts` replayable demo — `test/m07-recovery.test.ts` (T-013, T-014)
  - Reference acceptance end to end — `test/e2e-acceptance.test.ts`
- Commands, exit codes, tested environment: `node --test 'test/*.test.ts'` → **20 pass / 0 fail**, exit 0; clean-checkout proof via `git archive HEAD | tar -x` into an empty dir → same result; `node scripts/demo.ts` → full journey exit 0; `node scripts/browser-check.ts` → **23/23 browser checks**, exit 0. Node v22.23.1, macOS arm64; Chrome for Testing 158 headless shell.
- External dependencies and decisions: Kite rail (above). No paid calls, cloud sessions, pushes, PRs or deployments performed — per run constraints.
- First next action: none for local scope. To extend: swap `LocalSellerAdapter` for an authorized Kite seller route (fail-closed session-bound execution per KITE-AND-PROVIDERS.md) and wire `worker-main.ts` + `server.ts` to production env.
- Next agent must reproduce: `node --test 'test/*.test.ts'` → 20 pass; `node scripts/browser-check.ts` → 23 pass (needs a Chrome-family binary; see BROWSER.md).
