# PatchDub · Threat model

Limit subtitle upload size and cue count; reject malformed timecodes and inertly render subtitle markup. Provide provider-bound private object access only for authorized text. Escape WebVTT identifiers and content on serialization. Treat vendor output as untrusted text. A glossary or translator instruction must never expand spend or replace an independent review.

The web client, uploaded records and provider payloads are untrusted. Enforce organization, ownership and action-specific authorization at read and write boundaries. Test guessed IDs, stale approvals and access to evidence after membership revocation. Bound extraction payload sizes, validate data formats, redact secret-bearing query strings and keep private data out of public endpoints. Network clients restrict target schemes and destinations to configured providers. Keep customer data, tokens and payment details out of prompts and handoff logs.

Bind an operation to the actor, payload digest, amount limit, provider and expiry where applicable. Audit original and corrected decisions with actor and reason. Include redacted reproduction steps for a failed or unknown result. Align the retention policy with data rights agreed in the pilot.
