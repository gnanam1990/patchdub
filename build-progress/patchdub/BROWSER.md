# Browser verification — PatchDub operator console

Recorded 2026-11-20 on `devin/patchdub`. The console was driven end-to-end in a
real headless Chrome over the DevTools protocol; no API shortcuts were used
inside the journey (API calls only seed the fixture before sign-in and assert
final state).

## Runnable command

```sh
node scripts/browser-check.ts
```

Dependencies: Node >= 22 (built-in WebSocket + TS stripping; zero npm packages)
and a Chrome/Chromium binary. Browser resolution order:

1. `PATCHDUB_CHROME` env var (any Chrome-family binary)
2. `~/Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell`
   (verified: Chrome for Testing 158.0.8127.18)
3. `chromium_headless_shell-1248` in the same cache

Optional env:

- `PATCHDUB_CHROME_FLAGS` — space-separated launcher flags. Defaults to
  `--no-sandbox --single-process --disable-gpu`, which this sandbox requires
  because Chromium's Mach-port rendezvous is denied. On an unrestricted host
  you may clear or replace these.
- `KEEP_ARTIFACTS=1` — keep the disposable `data/browser-check-*` db/profile
  dirs for debugging (removed by default).

The script starts the API on an ephemeral port (`server.listen(0)`) backed by a
disposable SQLite dir, spawns the real worker process against the same data
dir, seeds the six-cue fixture via the API, then drives the UI through CDP.
Screenshots land in `build-progress/patchdub/evidence/browser/*.png`; the
actor token is entered into a `type=password` field so it is masked in
captures, and no customer data, secrets or provider identifiers appear.

## What the check proves (23/23 PASS at capture time)

- Sign-in -> edition list -> open case.
- Alignment table renders cue repair kinds (`edit`, `retime`, `unchanged`)
  with readable labels (`C4 · 12.5s–15.5s` retimed).
- Bounded quote `4 minor against cap 4` -> approve -> announce "dispatched".
- Real worker settles both orders; C5 is flagged by the required-term check.
- Final export is visibly blocked while the finding is open (error alert).
- Keyboard-only review: `j`/`k` move selection, `a` approves C2, `e` focuses
  the C5 editor, corrected Tamil inserted, `Esc` leaves the editor, `s` saves
  (finding resolves at the new digest), `a` approves.
- Final export listed; manifest shows `billableSeconds=8`, `totalMinor=4`,
  `paidItems=2`, `rail=local-emulator`.
- Selected cue persists across reload via the `#/edition/{id}/cue/{patch}` hash.
- 320 CSS px: no horizontal page overflow (`scrollWidth=320`, table scrolls
  inside the panel), keyboard nav and visible focus intact.
- Distributor view: review actions read "reviewer only", export buttons hidden,
  draft exports not listed.
- Bad token shows a visible "Sign-in failed" error.

## Evidence (redacted)

`build-progress/patchdub/evidence/browser/`:

- `01-alignment.png` alignment table with repair kinds and cue labels
- `02-quote.png` plan + glossary picker + bounded quote
- `03-export-blocked.png` visible blockers on final export attempt
- `04-review-resolved.png` C5 corrected, finding struck through, approved
- `05-final-export.png` review table + final export row
- `06-mobile-320.png` 320px review table, selected row focused
- `07-distributor.png` distributor (download-only) surface
- `08-signin-error.png` bad-token error alert

## Product gaps found and fixed by this verification

- Glossary picker was never populated, so UI-created plans could not pin a
  term base — now filled per case (`renderPlan`).
- Export artifact links used `window.open` without the actor token (401) —
  now fetched with `Authorization` and saved via a blob URL.
- Draft export rows were listed to distributors (API 403s) — now hidden;
  export buttons and review actions are role-gated too.
- Alignment table showed opaque row ids — now shows `cue_id + timing`.
- `state.me` was only set on the edition list, so a reload straight into a
  case lost role gating — now fetched lazily in `showCase`.
- `Esc` inside the variant editor now returns focus to the cue row
  (keyboard-only escape route); `?` help updated.
- At 320px the layout viewport expanded to 544px because the table could not
  shrink — `.panel` is now the horizontal scroll container and topbar items
  can shrink (`scrollWidth=320` verified).
- Reject without a reason is now rejected server-side (`reason_required`).

## Boundaries

- Provider rail remains `local-emulator`; no paid endpoint or live receipt was
  exercised. Live Kite proof is unchanged from HANDOFF.md.
- No real human reviewer involved; the reviewer token acts as the role.
