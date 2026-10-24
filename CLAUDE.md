# YummyAI Project Instructions

`CLAUDE.md` is the canonical project rule file. `AGENTS.md` is a byte-for-byte
mirror because this Windows workspace cannot create Git symlinks. Update both in
the same change; `pnpm check:rules` enforces equality.

## Product Boundary

- YummyAI is a tenant-isolated Amazon/Etsy research and listing ERP for custom
  and POD products.
- P0 ends at a reviewed, immutable export package. Marketplace authorization,
  publishing, and state writeback belong to P1.
- Do not simulate seller-console publishing with browser automation. P1 uses
  supported marketplace APIs and explicit store authorization.
- Competitor evidence is research input, never publishable source material.

## Toolchain

- Use Node.js 24.17.x and pnpm 11.10.x. Do not replace pnpm or regenerate the
  lockfile with another package manager.
- Start local infrastructure and applications with the commands in
  `docs/operations/local-development.md`.
- For the adopted daily ERP, use `pnpm daily:status` and `pnpm daily:start`.
  Keep the pinned runtime separate from the development tree; preserve healthy
  processes and never broaden execution policy to repair a rejected command.
- Core checks are `pnpm lint`, `pnpm typecheck`, `pnpm test`,
  `pnpm test:integration`, `pnpm test:e2e`, and `pnpm build`.
- Stop an active Next.js dev server before running the E2E suite in the same
  worktree; Next.js will not start the test server while the dev lock is held.
- Demo-mode flags are for isolated UI development only. Acceptance and release
  checks must use real application paths unless the E2E fixture explicitly owns
  the demo boundary.

## Repository Boundaries

- `apps/web`: Next.js ERP UI and local-development extension ingress.
- `apps/api`: authenticated REST boundary, tenant context, and business modules.
- `apps/worker`: BullMQ processors for long-running and retryable work.
- `apps/extension`: WXT Manifest V3 capture UI and marketplace content scripts.
- `packages/contracts`: shared Zod schemas and transport types.
- `packages/database`: Drizzle schema, migrations, and tenant transactions.
- `packages/authz`, `packages/storage`, `packages/jobs`, `packages/ai-core`, and
  `packages/platform-rules`: shared policy and infrastructure boundaries.
- Prefer existing module services and contracts. Do not add direct cross-module
  table writes or duplicate shared schemas inside applications.

## Tenant, Data, and Security Invariants

- Every tenant-owned database operation runs through `withTenant()` and the
  non-owner application role. Never bypass forced PostgreSQL RLS.
- Tenant context comes from authenticated membership, not a caller-selected
  header or raw tenant ID.
- Capture snapshots, approved design versions, listing versions, and export
  manifests are immutable. Changes create a new version.
- Research and authorized assets use separate domains and object prefixes.
  Competitor assets cannot be promoted or exported.
- Local extension proxy routes are loopback development conveniences only.
  Production extension requests use OIDC Authorization Code with PKCE.
- Never commit or log credentials, tokens, cookies, authorization headers, raw
  prompts containing secrets, or production marketplace data.
- API client and Webhook secrets use a dedicated integration encryption domain;
  do not reuse marketplace, order-PII, or model-provider keys.
- Keep object storage private and authorize every signed read by tenant and asset
  domain.

## Marketplace Capture Rules

- Read only content visible in the public page DOM. Do not access cookies,
  passwords, seller-only APIs, protected endpoints, CAPTCHAs, or anti-bot bypasses.
- Isolate selectors by field and return missing-field diagnostics. Preserve
  partial captures instead of failing unrelated evidence.
- Normalize marketplace URLs before matching research items. Re-capture creates
  a new snapshot and never overwrites history.
- Reviews are opt-in and default to disabled. When enabled, preserve the user-set
  page delay, progress, pause state, and collected-versus-reported counts.
- Deduplicate media by canonical source and content identity. Treat video and
  image records as distinct media kinds.
- Preserve useful raw evidence even when a current UI chooses not to display a
  field. Removing a persisted field requires a contract and migration decision.

## Frontend Rules

- Preserve the quiet, dense, work-focused ERP visual language. Do not turn
  operational pages into marketing layouts or nested decorative cards.
- Keep navigation stable across routes. Use existing Lucide icons, tokens, and
  component patterns before introducing new UI primitives.
- Long titles, descriptions, variant values, and diagnostics must wrap without
  horizontal overflow. Fixed-format controls need stable responsive dimensions.
- Use available frontend design skills for material UI changes, then verify the
  real page in a browser at desktop and mobile-relevant widths.
- Empty, loading, partial, unauthorized, and failed states must remain explicit.
  Never fabricate unavailable marketplace values.

## Change and Test Discipline

- Preserve unrelated user changes in a dirty worktree. Do not reset, checkout,
  or rewrite files outside the requested scope.
- Run integration suites through the disposable acceptance runner. Every
  integration config must reject a missing isolation flag or non-disposable
  database before connection; ordinary unit runs must exclude integration files.
- Clean up test-created data and associated resources after testing in every
  module, including manual, API, and browser tests, unless the user asks to keep
  them. Track exact fixture IDs and use failure-safe teardown; resume cleanup
  after an interruption. Use supported deletion or archival flows, preserve real
  business data and required immutable history, and verify related lists, search,
  and counts are clear. Report any retained test history or incomplete cleanup.
- Parser changes require parser tests, extension typecheck/build, extension
  reload, and a smoke test on the affected marketplace.
- After inspecting acceptance results, remove agent-generated temporary logs,
  screenshots, traces, test downloads and identified test caches. Retain source
  tests, product documents, concise validation conclusions and cleanup records.
  Verify absolute owned paths and active processes; never follow junctions into
  shared sources or dependencies. See `docs/project-control/DELIVERY_PROTOCOL.md`.
- Tenant, auth, storage, capture, review, and export changes require integration
  coverage. Cross-route UI changes require E2E coverage where practical.
- A P0 release candidate requires lint, typecheck, unit, integration, E2E, build,
  current Chrome/Edge extension packages, browser smoke evidence, and a verified
  backup/restore drill on the exact candidate commit.
- Do not create a release tag or claim a phase complete while required checks are
  missing, the worktree is dirty, or CI has not validated the candidate commit.

## Production Artwork Discipline

- Before making, changing, testing, or reviewing shaped-pillow artwork, read
  `docs/operations/custom-pillow-workflow.md` and verify the order's pinned
  manufacturing version against the user's latest confirmed requirements.
  Other products require their own supplier specification.
- Read the order's pinned Rule Center snapshot as well as its template version.
  Legacy tasks without a snapshot must be identified explicitly; never backfill
  them with today's rules. Maintain business-rule sources and execution status
  through `docs/integration/rule-center.md`; new prose is manual review guidance,
  not executable automation or authority to override production checks.
- Follow the documented make/check/correct/server-verify/review workflow. Keep
  working on recoverable defects within the authorized scope; a failed first
  check is not a completed production-file task. Never relax a quality gate,
  relabel DPI, or manufacture approval to obtain a passing result.
- Pin the recipe, model route, processing parameters, source provenance, and
  output assets. Reuse valid checkpoints; preserve immutable originals and
  versions. Geometry-only corrections must not regenerate or alter the artwork.
- Distinguish an agent's technical checks, operator approval, factory acceptance,
  and actual production release. Record any manual intervention and automation
  gaps; a successful assisted order does not prove unattended operation.

## Documentation Map

- User guide: `docs/user-guide.md`
- Current full-platform PRD: `docs/erp-blueprint/01-product-requirements.md`
- Execution/knowledge/creative specifications: `docs/erp-blueprint/15-agent-harness-specification.md`,
  `16-knowledge-governance-specification.md`, and `17-creative-capability-migration.md`
  in the same directory.
- Live project progress/recovery: `PROJECT_STATUS.md`, `PROJECT_HANDOFF.md`
- Historical P0 product baseline: `docs/superpowers/specs/2026-07-17-yummyai-erp-design.md`
- P0 implementation baseline: `docs/superpowers/plans/2026-07-17-yummyai-erp-p0.md`
- P1 implementation plan: `docs/superpowers/plans/2026-07-19-yummyai-erp-p1.md`
- P2 implementation plan: `docs/superpowers/plans/2026-07-20-yummyai-erp-p2.md`
- P3 implementation plan: `docs/superpowers/plans/2026-07-22-yummyai-erp-p3.md`
- Architecture decisions: `docs/architecture/`
- API and connector integration guides: `docs/integration/`
- Local, deployment, backup, and restore procedures: `docs/operations/`
- Security boundaries: `docs/security/threat-model.md`
- Update integration/architecture/runbook documentation when adding routes,
  environment variables, database tables, auth flows, or external connectors.
- Keep this file as a concise rule manual. Put feature history in Git or release
  notes, operational detail in runbooks, and product behavior in the PRD.
