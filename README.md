# PatchDub

Tamil subtitle edition maintenance for rights-cleared training videos. Imports
a previous source WebVTT track, its approved Tamil track and a replacement
source revision; aligns cues; prices the changed window against a producer
spend cap; dispatches translation orders through a seller adapter; runs
terminology and timing checks; and exports the approved revision with a
provenance manifest and billable-interval ledger.

## Stack

Node 22+ with native TypeScript type stripping. Zero npm dependencies:
`node:http` API, `node:sqlite` storage with versioned migrations under
`migrations/`, `node:test` suite, static console in `public/`.

## Run

```sh
npm start          # API + console on http://localhost:8787
npm run worker     # supervised outbox worker (separate process)
npm run demo       # replayable end-to-end demo on the labeled fixtures
npm test           # full suite (node --test 'test/*.test.ts')
```

Data lands in `./data/` (or `PATCHDUB_DATA`). Env: `PORT`,
`PATCHDUB_DB`, `PATCHDUB_SETTLE` (`auto|manual|unresolvable` for local
adapter fault injection).

## Flow

1. `POST /api/workspaces` → workspace + producer token (shown once).
2. Producer creates actors: `POST /api/workspaces/{id}/actors` (roles:
   `producer`, `editor`, `reviewer`, `distributor`, `operator`).
3. Editor imports `source`/`target` revisions, then a replacement `source`
   with `parentId`. All requests carry `Authorization: Bearer <token>`.
4. `POST /api/revisions/{id}/alignment/recompute`, resolve ambiguous groups
   via `PUT /api/revisions/{id}/alignment/{groupKey}`.
5. `POST /api/revisions/{id}/repair-plans` (cap + optional glossary), then
   `POST /api/plans/{id}/approve` with an idempotency key — atomic reserve +
   outbox dispatch.
6. Worker translates via the seller adapter; checks produce findings.
7. Reviewer edits variants (`PUT /api/patches/{id}`, `If-Match`) and approves
   (`PUT /api/patches/{id}/review` bound to the current digest).
8. `POST /api/revisions/{id}/exports` (`draft` labeled, `final` gated);
   `GET /api/exports/{id}/artifact|manifest`.
9. `GET /api/operator/queue` + `POST /api/purchases/{id}/reconcile` for
   uncertain settlements.

## Provider rail

Ships `LocalSellerAdapter` (rail `local-emulator`), a deterministic seller
emulator whose order book persists in SQLite so receipts survive restarts.
The live Kite rail requires operator-authorized credentials not present in
this environment; all paid outcomes are labeled `local-emulator` and kept
separately identifiable (see `docs/build-pack/KITE-AND-PROVIDERS.md`).

## Layout

- `src/` — API (`app.ts`, `http.ts`), domain (`align`, `plans`, `checks`,
  `patches`, `exports`, `recovery`), worker (`worker.ts`), adapter
  (`provider.ts`), storage (`db.ts`), WebVTT (`vtt.ts`).
- `migrations/` — versioned SQL.
- `public/` — operator console (keyboard-driven review table).
- `fixtures/` — labeled, rights-cleared sample tracks.
- `test/` — module tests mapping to the pack's T-001…T-014 plus invariant
  coverage.
- `build-progress/patchdub/` — durable handoff + status.
