# P0 threat model

## Assets and trust boundaries

Protected assets are tenant records, private files, provider credentials, user sessions, AI prompts/results, export packages, and audit history. Trust boundaries exist at the browser extension, web/API edge, OIDC issuer, worker queue, PostgreSQL RLS role, Redis, S3/MinIO, external AI providers, and OTLP pipeline.

| Threat | Control | Verification |
|---|---|---|
| Cross-tenant IDOR | permission guard, tenant context, forced PostgreSQL RLS, tenant-prefixed object keys | integration and E2E RLS tests |
| Research media exported as production | separate asset domains, rights approval, processor-side recheck | export processor tests |
| Approved content mutated | immutable DB triggers and version creation | design/Listing integration tests |
| Prompt injection changes tools/budget/schema | untrusted source message separation, fixed tool policy, output schema, evidence validation | analysis processor fixtures |
| AI cost exhaustion | per-task and monthly budget ledger/caps | AI gateway tests |
| Credential/log leakage | secret vault, centralized recursive redaction, collector attribute removal | redaction tests and CI scan |
| Replay/duplicate jobs | UUIDv7 envelope, idempotency key, attempt cap | jobs contract/queue tests |
| Stale or stolen file URL | tenant/domain check and signed URL expiry ≤600s | storage policy/E2E tests |
| Malicious captured HTML | parser allowlist, public DOM extraction, no page-script instructions | extension parser tests |
| Backup disclosure or destructive restore | encrypted off-host retention, checksums, isolated restore target, two-person production switch | restore drill evidence |

## Abuse cases

- Disabled memberships must fail before tenant context creation.
- A user cannot select a tenant solely by request header; membership is resolved from the authenticated subject.
- Competitor/research files cannot be promoted by changing metadata; promotion copies through the policy service and creates a new authorized record.
- Job progress and notification streams are tenant scoped and resume only from visible event IDs.
- Raw prompts, authorization headers, tokens, cookies, and credentials are excluded from logs and telemetry.

## Residual risks

P0 does not publish to marketplaces and has no order/customer PII. Public page layout changes may create partial captures; diagnostics and human review are the mitigation. Shared-infrastructure administrator compromise remains an operational risk addressed by least privilege, audit, backups, and credential rotation.
