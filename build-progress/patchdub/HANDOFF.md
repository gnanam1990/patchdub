# PatchDub · Session handoff

Initial state: greenfield dedicated repo `patchdub`, branch `devin/patchdub`. Single implementation agent (local SWE-2 High). No prior progress existed.

## Stack decision (recorded 2026-11-20)

- Greenfield target; TDD proposes "typed HTTP application, PostgreSQL, supervised worker, role-aware web console".
- No PostgreSQL server is running locally (`pg_isready` → no response) and npm access is out of scope, so the build uses **Node 22 + TypeScript (native type stripping), node:http, node:sqlite with versioned SQL migrations, node:test**. Zero external dependencies. SQLite supplies the same transactional-outbox and compare-and-set guarantees locally; the DB layer is isolated in `src/db.ts` so a Postgres port is a storage swap.
- Live Kite rail unavailable in this run (no authority for paid calls): the seller boundary is `LocalSellerAdapter` (`src/provider.ts`, rail `local-emulator`) with a persistent SQLite order book so receipts survive restarts. Exact missing proof: an operator-authorized Kite seller endpoint + settled live receipt. All paid outcomes are labeled `local-emulator` and kept separately identifiable.
- Web console: static accessible UI in `public/` served by the API (built in M05).

## Status

- Target repository / branch / tested SHA: this checkout, `devin/patchdub`
- Current module and owner: M02 next; M01 implemented
- Completed behavior and redacted evidence path: workspace/actor/edition bootstrap, bounded WebVTT import with sha256 + artifact storage, idempotent retry (INV-01), line-level parse errors, tenant-scoped reads. Evidence: `node --test test/m01-import.test.ts` → 4 pass / 0 fail.
- Commands, exit codes and tested environment: `node --test test/` on Node v22.23.1, macOS arm64. Exit 0.
- External dependencies and decisions: see stack decision above; consult KITE-AND-PROVIDERS.md.
- First next action: run `node --test test/` then continue with M02 alignment (`src/align.ts`, `src/plans.ts` are already written — verify with test/m02 test file).
- Next agent must reproduce: `node --test test/m01-import.test.ts`
