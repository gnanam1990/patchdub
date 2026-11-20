# PatchDub · Product requirements

## Product decision

Maintain Tamil subtitle editions of rights-cleared training videos. Deliver an approved WebVTT revision with provenance, a cost ledger and a changed-cue report. The initial product promises subtitle localization. Voice cloning, finished dubbed audio and buying rights to source footage require separate workflows.

**Buyer and commercial hypothesis.** Localization studios maintaining multilingual training videos. Charge per accepted updated minute or a studio subscription.

**People and responsibilities.** A localization producer owns an episode and spend ceiling. An editor uploads source and approved target tracks. A native-language reviewer may edit terms and approve or reject individual patches. A distributor downloads only an approved edition.

## Customer journey

Import a previous source track, its approved Tamil track and a replacement source revision. The producer confirms ambiguous mappings, inspects the repair window and approves a bounded quote. A translator processes the changed text. The reviewer resolves terminology and timing flags, then exports the exact approved revision.

## Acceptance scene

Use six four-second cues, C1–C6, on a 24-second track. C2 and C5 change text. C4 moves to 12.5–15.5 s without a text change. Order translations for the two changed cues at an agreed price of 2 minor units per cue and a cap of 4. Exactly two translations are requested for total 4, C4 reuses approved Tamil and gets a timing check, and the union of paid updated intervals is 8 seconds. A required term missing in C5 holds export until the language reviewer approves its corrected digest. At a cap of 3, dispatch zero orders for this all-or-none plan.

## Behaviors for the team

- **FR-01 · Revision and subtitle import.** Create workspace-scoped episode storage, bounded WebVTT parsing, original hashes and previous-target associations. Preserve parsed cue text and millisecond timestamps.
- **FR-02 · Alignment and repair planning.** Map old and new cues, record reasons and groups, distinguish retime, edit, insertion and deletion, and offer a manual disambiguation action.
- **FR-03 · Scoped purchase and translation worker.** Price the full approved repair window, reserve the cap atomically, dispatch through the chosen Kite-compatible seller and record the rail and independently observed receipt. Keep a local adapter for deterministic contract testing.
- **FR-04 · Terminology and timing checks.** Validate numbers, placeholders and glossary terms against the pinned revision. Check cue bounds, unintended overlap and display-time limits. Emit per-cue findings and source offsets.
- **FR-05 · Reviewer workspace.** Build accessible timeline navigation, editable target rows, reasoned resolve/reject actions, cost indicators and version-aware saves.
- **FR-06 · Export and billable intervals.** Serialize valid UTF-8 WebVTT, ordered cues and a manifest with parent hashes, findings and accepted usage. Calculate billable changed seconds as an interval union.
- **FR-07 · Recovery and studio acceptance.** Add an operator queue for unknown charges, artifact retention and a replayable studio demonstration through upload, review, purchase and export.

The [acceptance contract](CORE-CONTRACT.md) defines the fail/hold conditions for each requirement. Show the operator the responsible actor, decision reason, missing input and next possible action.

## Demand and release evidence

One producer and native reviewer supply two revisions of a licensed short course with a previously accepted Tamil track. Compare time to accepted export and translation spend with reprocessing the full track. Agree on a rubric for terms and timestamps before the trial. Use an operator-authorized translation service supporting the required locale, privacy and payment rail.

Track completed cases over attempted cases, human exceptions, time to resolution and direct provider costs. Preserve the denominator and separate demonstration records from pilot records. Compare with the buyer's current manual workflow on the same cases. The adjacent Atlas project is [DubFlow](https://devpost.com/software/dubflow); customer willingness to pay requires pilot evidence.

## Larger team scope

- Revision alignment across splits, merges, insertions and retimings
- Per-language term bases, translation memory provenance and sealed reviewer decisions
- Supplier-specific pricing, work assignment and vendor response recovery
- Versioned subtitle exports, change logs and acceptance comparison by locale

These are product surfaces for a substantial team backlog. Size independently deliverable changes from real integrations, acceptance cases and findings. Around 500 meaningful commits is a scope preference. Actual change count follows the implementation.
