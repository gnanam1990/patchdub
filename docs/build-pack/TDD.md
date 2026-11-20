# PatchDub · Technical design

## Architecture and ownership

Preserve an established target repo's stack and conventions. For a greenfield target the proposed baseline is a typed HTTP application, PostgreSQL, a supervised background worker and a role-aware web console. Use object storage for large evidence, opaque references in the database, and server-side authorization on retrieval. A transaction writes a domain decision and its outbox row together. A worker processes external side effects and stores a durable result independently of the browser session.

**Actors.** A localization producer owns an episode and spend ceiling. An editor uploads source and approved target tracks. A native-language reviewer may edit terms and approve or reject individual patches. A distributor downloads only an approved edition.

## Domain schema

Workspace(id, locale, retention_days); Edition(id, workspace_id, source_locale, target_locale, active_revision); Revision(id, edition_id, parent_id, input_sha256, imported_at); Cue(revision_id, cue_id, start_ms, end_ms, source_text, source_hash, approved_target_text); Alignment(old_revision, new_revision, old_cue_ids, new_cue_ids, reason, confidence, resolver); Patch(id, edition_id, new_revision, group_key, change_kind, glossary_digest, expected_version, status); Purchase(patch_id, provider_id, quote_minor, token, decimals, rail, external_ref, status); Review(patch_id, variant_hash, reviewer, verdict, timestamp); Export(id, revision_id, artifact_hash, manifest_hash). Store original file bytes separately. Scope every object lookup to its workspace.

Index tenant-scoped business keys, workflow status and pending work. Version migrations and test forward migration from a populated previous schema. Write quantities and currency using explicit units and integer minor or token units. Persist the precision alongside provider amounts. A comparison involving different currencies requires an explicit valuation source and timestamp.

## HTTP and worker boundaries

POST /editions; POST /editions/{id}/revisions; GET /revisions/{id}/alignment; PUT /revisions/{id}/alignment/{group}; POST /revisions/{id}/repair-plans; POST /plans/{id}/approve; GET /patches/{id}; PUT /patches/{id}/review with If-Match; POST /revisions/{id}/exports; GET /exports/{id}/manifest.

Apply tenant membership and action scope on the server. Use a durable idempotency key on commands that can trigger work or payment. An identical retry returns the stored operation reference. A different payload under the same key yields a conflict. Keep polling and webhooks causally tied to the original operation. Apply provider signature verification when supported and reject unverified callbacks as evidence of settlement.

## Decision procedure

Parse WebVTT timestamps into integer milliseconds. Preserve the original approved Tamil string for stable, text-identical cues. Use unique supplied cue IDs first, then monotonic time overlap and text agreement as candidate evidence. Many-to-one, reordered repeated lines and low-confidence mappings require review. Distinguish retiming from textual change. A retimed equivalent needs a timing check and no translation purchase. For an insertion or changed text, provide adjacent cues to a translator as read-only context. Quote only the implicated window and pin the glossary digest; cap price, destination, expiry and total spend through a currently supported Kite path. Validate protected names, numbers, placeholder sets, configured timing overlap and line length. Require approval of the current variant digest before export. Report accepted updated minutes by union of changed target intervals, with full precision internally.

## State model

Revision imported → alignment_review or plan_ready → awaiting_budget → translating → language_review → exportable → exported. A translator timeout moves the purchase to unknown and preserves a reservation. Editing source, mapping or glossary creates a new plan or marks dependent reviews stale. An unresolved translation, timing flag or unknown purchase blocks a final approved export; draft preview is labeled.

## Recovery

Key the translation order by provider, target locale, approved repair group, source revision and glossary digest. Record reservation and outbox in the same transaction. Resolve uncertain settlement by original reference before resubmitting. Rebuild previews from immutable inputs. Resume after a crash without losing accepted variants, issuing a second purchase, or reusing a review for a newer digest.

Use a compare-and-set version or row lock for conflicting decisions. Persist an intent before dispatch. If the provider cannot establish what happened, expose a pending-reconciliation state and stop automatic redispatch. Reconcile with the original provider reference, exact amount and scope. Maintain append-only corrections where users depend on the original evidence.

## Operations and integration

Record operation ID, actor role, decision code, latency and the external reference in access-controlled logs. Track stalled operations by age and surface them to the responsible role. Run migrations before workers, test a process restart during an in-flight request, and check convergence from an independently restored database. Deploy web and worker with separate credentials. See [the integration contract](KITE-AND-PROVIDERS.md) and [the tests](TEST-PLAN.md).
