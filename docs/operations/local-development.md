# Local development

## Prerequisites

- Node.js 24.17.x and pnpm 11.10.x
- Docker Desktop with Compose v2
- Chrome or Edge for extension smoke tests

## Start

### One-click Windows startup

Double-click `start-yummyai.cmd` in the repository root, or run:

```powershell
pnpm start:local
```

The launcher is idempotent. It starts Docker Desktop when needed, starts only
the YummyAI Compose services, applies migrations, refreshes the local extension
account, and starts missing API, Web, Worker, and extension processes. Existing
unrelated containers and processes are never stopped. If port `3000` is already
serving another active Web workflow, the launcher uses an isolated Web runtime
on `3002` and points the development extension at that proxy. Startup logs and
the last resolved endpoints are stored under `%LOCALAPPDATA%\YummyAI`.

The launcher reloads only the YummyAI development extension so its proxy target
is deterministic. Use the newly opened Chrome window, refresh the public Amazon
or Etsy page, and then click **发送到研究库** or **保存竞争店铺**.

### Manual startup

```powershell
Copy-Item .env.example .env
pnpm install --frozen-lockfile
pnpm infra:up
pnpm --filter @yummyai/database db:migrate
pnpm dev
```

The default path preserves the complete local runtime:

- `pnpm infra:up` starts PostgreSQL, Redis, MinIO, Keycloak, ClamAV, and the OpenTelemetry Collector.
- `pnpm dev` starts the API, Web application, Worker, and WXT extension hot reload.

These commands retain the existing full-feature behavior. For a memory-bounded session that only needs synchronous API and Web work, start from a stopped Compose project and use:

```powershell
pnpm infra:lite
pnpm dev:lite
```

The low-memory Compose override leaves ClamAV and the OpenTelemetry Collector stopped, while the low-memory development command omits the Worker and WXT watcher. It does not replace the normal runtime for file scanning, background jobs, extension capture, observability acceptance, or full cross-module verification. If the full stack is already running, stop its optional containers before switching modes:

```powershell
docker compose --env-file .env -f infra/docker-compose.yml stop clamav otel-collector
```

Start an omitted component without restarting the rest of the session when a workflow reaches it:

```powershell
pnpm dev:worker
pnpm dev:extension
pnpm infra:file-scanning
pnpm infra:observability
```

`pnpm infra:full` and `pnpm dev:full` are explicit aliases for the normal complete runtime. `pnpm dev:web` is available for isolated UI work; demo-mode flags remain restricted to that isolated UI boundary and are not valid acceptance evidence.

The Web application owns `http://localhost:3000`. WXT uses `http://localhost:3001` for extension hot reload so `localhost` cannot resolve to the wrong development server.

The root development scripts load `.env` through Node before starting Turbo. `turbo.json` explicitly passes the Web server's API and local OIDC variable names to development tasks; keep `pnpm check:rules` green when that set changes. The Web package also loads `../../.env` and runs an environment preflight before `next dev`, so an accidental `pnpm dev` from `apps/web` cannot silently start without `API_BASE_URL`. Missing server configuration must render an explicit error and must never be presented as a legitimate empty dataset. API and Worker scripts also load the same root `.env` directly. Do not put provider credentials into browser-visible `NEXT_PUBLIC_*` variables.

The Worker uses `DATABASE_URL`, `REDIS_URL`, the marketplace application variables, the same `MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY` as the API, and `CLAMAV_HOST`/`CLAMAV_PORT`/`CLAMAV_TIMEOUT_MS` for quarantined customer-file scanning. The API and Worker share the separate `ORDER_PII_ENCRYPTION_KEY`: purpose-bound order-personalization jobs decrypt protected fields only in Worker memory while preparing or rendering a pinned encrypted slot-resolution snapshot. API client and Webhook signing secrets use `INTEGRATION_SECRET_ENCRYPTION_KEY` in both the API and Worker. In non-production local development only, each encryption domain derives a distinct fallback key from `LOCAL_OIDC_CLIENT_SECRET`.

Order-context rendering is disabled unless `POD_ORDER_PROCESSOR_URL`, `POD_ORDER_PROCESSOR_API_KEY`, `POD_ORDER_PROCESSOR_DEPLOYMENT_ID`, and `POD_ORDER_ENABLED_TOOLS` are all set. The allowlist accepts `image_composite`, `group_photo`, `pet_outfit`, `fulfillment_composite`, and `vector_fulfillment`; `POD_ORDER_PROCESSOR_MAX_OUTPUT_BYTES` defaults to 50 MiB. These credentials and the endpoint are separate from the ordinary `POD_PROCESSOR_*` variables because the order processor receives minimum-necessary customer text and file bytes. Use only a locally controlled fixture processor in development, never a shared public image endpoint.

Default endpoints are PostgreSQL `5432`, Redis `6379`, MinIO `9000/9001`, Keycloak `8081`, ClamAV `3310` (loopback only), and OTLP `4317/4318`. Change host ports in `.env` when they collide; keep container ports unchanged. ClamAV needs several GiB of RAM while loading and refreshing signatures, so allocate enough Docker Desktop memory before enabling P2-C file scans.

## Health and diagnostics

```powershell
docker compose --env-file .env -f infra/docker-compose.yml ps
docker compose --env-file .env -f infra/docker-compose.yml logs --tail=100 postgres redis minio keycloak clamav otel-collector
pnpm --filter @yummyai/database exec drizzle-kit check
pnpm check:local-runtime
```

In a low-memory session, ClamAV and OpenTelemetry Collector logs exist only after those components have been started explicitly.

Run `pnpm check:local-runtime` after starting API and Web. It compares the
tenant-scoped research, marketplace-account, and competitor-shop API responses
with the rendered `/research`, `/stores`, and `/competitors` pages. The check
fails if a page reports missing API configuration or does not render data that
its API returned.

Use `DASHBOARD_DEMO_MODE=1`, `ANALYSIS_DEMO_MODE=1`, `PRODUCT_DEMO_MODE=1`, `DESIGN_DEMO_MODE=1`, and `LISTING_DEMO_MODE=1` only for UI development. Never set demo flags in deployed environments.

## POD artwork processor development

The POD workbench tool catalog is readable without a processor, but task creation fails closed until a verified processor deployment is explicitly configured for both the API and Worker:

```dotenv
POD_PROCESSOR_URL=https://processor.example.test/v1/execute
POD_PROCESSOR_API_KEY=replace-with-a-local-test-secret
POD_PROCESSOR_DEPLOYMENT_ID=pod-test-2026-08-03
POD_ENABLED_TOOLS=pattern_crop,print_extract,background_remove,super_resolution,outpaint,crop_compress,vectorize,authorized_watermark_remove,design_variation,text_to_image,series_design,canvas_extend,seamless_pattern,seamless_stitch,product_suite,title_draft,virtual_try_on,background_replace
POD_PROCESSOR_MAX_OUTPUT_BYTES=52428800
```

`POD_ENABLED_TOOLS` accepts the generic executable keys documented in `docs/integration/pod-workbench.md`, including the isolated POD-3 keys `product_video`, `piece_extract`, `piece_compose`, and `uv_layers`. Order-context tools are intentionally rejected by this allowlist. The API exposes a tool as enabled only when the URL, secret, deployment ID, and allowlist are all present; the Worker uses the same condition before registering the queue consumer. Keep the secret server-only. A loopback `http://localhost` processor is allowed for local development, while non-loopback processor URLs must use HTTPS.

Apply the POD task migration and verify the identifier-only queue, worker policy checks, and tenant boundary before an end-to-end processor smoke:

```powershell
pnpm --filter @yummyai/database db:migrate
pnpm --filter @yummyai/contracts test -- pod/pod.test.ts pod/governance.test.ts
pnpm --filter @yummyai/jobs test -- pod-artwork.test.ts
pnpm --filter @yummyai/api test:integration -- pod-artwork-task.integration.test.ts
pnpm --filter @yummyai/worker test -- pod-artwork.processor.test.ts pod-artwork.http-gateway.test.ts pod-export.processor.test.ts pod-personalization-resolver.test.ts
pnpm --filter @yummyai/web test -- pod-governance-actions.test.ts pod-workbench.test.tsx
pnpm --filter @yummyai/database exec drizzle-kit check
```

Use only a deterministic non-production processor fixture for local acceptance. Confirm that a successful run creates a new pending-review design version and authorized-domain AI asset with model, version, seed, technical metadata, AI inference regions, and task provenance; it must not create a publishable export. Research-domain inputs are accepted only by `rights_risk_scan`. Customer-provided inputs are rejected by ordinary artwork tasks. All transform tools require rights-approved authorized assets, watermark removal requires explicit rights attestation, and licensed brand/IP fusion also requires a license reference.

After manually approving the generated design version, request an export from the POD task center. Confirm that the Worker produces a private ZIP containing `manifest.json`, that the export row becomes `completed`, and that the UI obtains a short-lived read URL. Changing rights state or file bytes before packaging must fail closed. The export job payload must contain only `exportId`.

For the POD governance UI smoke, run the deterministic fixture with `POD_FIXTURE_PORT` set to the web app's local `API_BASE_URL` port (or pass the port as the fixture script's first argument). Open `?module=print_extraction&tool=pattern_crop` and verify mode, multi-crop limit, format/background, padding, result label, fixed perspective correction, and strict crop evidence. Switch to `tool=print_extract` and verify scenario, correction strength, restoration, transparent-format constraints, minimum completeness, and marked AI-region evidence. Open `?module=print_design&tool=series_design` and verify required batch prompts, fixed PNG/count/AI controls, prompt fingerprint, complete input coverage and two per-file evidence rows; switch to `tool=seamless_pattern` and verify repeat direction, immutable seam/tile checks and reviewed flat-pattern evidence. Spot-check asset-free `text_to_image`, licensed-brand proof, canvas-extension regions and non-generative `seamless_stitch`. Open `?module=listing_assets&tool=product_suite` and verify platform/locale, category, template, partial-success slot evidence and stable failure code; switch to `title_draft` and verify separate confirmed facts, keyword constraints, rule version, title counts and mandatory text review. Spot-check model-license rejection in `virtual_try_on`, subject-preservation rejection and marked background regions in `background_replace`, then verify reviewed candidates can only bind a fixed Listing version and slot. Open `?module=pattern_processing&tool=outpaint` and verify ratio, direction, format, optional prompt, immutable AI marking, and the reviewed extension rectangle; switch to `tool=vectorize` and verify SVG/EPS, color count/mode, smoothing, path closure, SVG safety notice, and strict path evidence. Spot-check transparent JPEG rejection in `crop_compress` and the mandatory rights confirmation in `authorized_watermark_remove`. Open `?module=rights_risk&tool=rights_risk_scan` and verify depth, Amazon/Etsy scope, validity, search terms, the fixed non-legal-opinion warning, blocked high-risk evidence, source/model versions, and a separately labelled visual similarity percentage; then run visual search and verify similarity remains visibly separate from legal risk. Open `?module=listing_assets&tool=product_video` and verify the reviewed-output boundary plus duration, framing, resolution, FPS, transition, caption, licensed soundtrack, AI-motion, fixed safe-area controls, and the strict MP4 evidence in the task center. Open `?module=personalization` and verify blank template creation, PNG/PSD source inspection status, four-class slot confirmation, explicit warning acknowledgement, the repeated `customer_image_1` mapping for same-name slots, approval, and explicit SKU/size binding. Open `?module=production_artwork`, switch the production type between bitmap and vector fulfillment, and verify SVG template profile, physical canvas, text-to-path, hollow/bridge, minimum-line-width, path-repair controls, strict evidence, file metadata, and approve/reject controls. The fixture is UI-only; release acceptance still uses tenant-backed APIs and real storage paths.

The PNG/PSD inspection worker is built in and registers the `personalization-template-source-inspection` queue whenever the normal Worker runs; it does not use `POD_PROCESSOR_*`. Apply migration `0049_personalization_template_source_inspections`, keep Redis and MinIO available, and restart API, Worker, and Web. The source must already be a non-customer asset in the authorized domain with approved rights. The queue payload contains only `inspectionId`; the Worker revalidates the pinned source version and SHA-256 before reading private bytes. Use a non-production PSD with controlled `image`, `text`, `decoration`, and `background` groups, then verify warnings must be acknowledged and one inspection cannot create two template versions.

## Canvas batch design and controlled mockup rendering

The canvas batch workbenches are disabled by default. Batch design uses the
ordinary POD processor and additionally requires both `text_to_image` and
`canvas_extend` in `POD_ENABLED_TOOLS`. Enable its API and Worker boundary only
after Redis, the Worker, and that pinned processor deployment are ready:

```dotenv
POD_BATCH_WORKFLOWS_ENABLED=true
```

The repository-owned mockup path requires ImageMagick 7. Set
`POD_MOCKUP_MAGICK_PATH` to the `magick` executable, keep the memory, map, disk,
thread, file, time, canvas, and output limits from `.env.example`, then set:

```dotenv
POD_MOCKUP_RENDERER_ENABLED=true
```

The independent creative UI is available at `/creative-designs`; the former
`/pod-workbench/batch-designs` path redirects there without dropping its batch
query parameter. The UI still keeps `/pod-workbench/mockup-batches` unavailable until the tenant
has at least one approved template pack. A template pack can only be assembled
from a rights-approved authorized PSD that compiled successfully, reached SSIM
0.99 against its saved composite, and was explicitly confirmed by a reviewer.
The four BullMQ queues carry identifiers only: `creative-design`,
`creative-design-adaptation`, `mockup-template-compile`, and `mockup-render`.

Apply migrations and verify the deterministic renderer with the repository PSD
fixture before enabling the flags:

```powershell
pnpm --filter @yummyai/database db:migrate
pnpm --filter @yummyai/database exec drizzle-kit check --config drizzle.config.ts
pnpm --filter @yummyai/mockup-renderer test
pnpm --filter @yummyai/mockup-renderer smoke
pnpm --filter @yummyai/database exec vitest run --config vitest.integration.config.ts src/pod-batches.integration.test.ts
```

The smoke script uses a network-disabled, CPU/memory/PID-limited ImageMagick 7
container and the real `packages/mockup-renderer/fixtures/controlled-canvas.psd`
fixture. Production can use an installed ImageMagick 7 executable through the
same argument-array runner; do not wrap it in a shell command.

## Verification

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
```

The extension build is in `apps/extension/.output/chrome-mv3`. Run `pnpm --filter @yummyai/extension zip` to produce Chrome and Edge packages.

## Extension smoke test

After changing a marketplace parser, rebuild the extension, click **Reload** for YummyAI Capture on `chrome://extensions`, and refresh the open Amazon or Etsy page before testing:

```powershell
pnpm --filter @yummyai/extension test
pnpm --filter @yummyai/extension build
```

In the popup, **重新读取** only refreshes the local preview. It does not create a research snapshot. Click **发送到研究库** and confirm that the research item gains a new version with the current parser version. For Etsy listing smoke tests, verify the preview includes the shop name, estimated delivery, shipping cost, origin, destination, listing date, and favorite count when those values are visible on the public page.

For local development, the extension sends captures through the localhost Web proxy. It accepts requests only from the configured unpacked extension ID and forwards them to the API with the local service identity, so normal capture tests do not depend on an interactive browser login. Direct API deployments still use the OIDC PKCE flow; after `pnpm --filter @yummyai/api bootstrap:local`, the local account is `yummyai-local` / `yummyai-local-2026` unless `LOCAL_EXTENSION_USER*` values were overridden in `.env`.

## P1 marketplace connector development

Apply migrations before testing store accounts:

```powershell
pnpm --filter @yummyai/database db:migrate
pnpm --filter @yummyai/contracts test -- store.test.ts
pnpm --filter @yummyai/marketplace-connectors test
pnpm --filter @yummyai/api test:integration -- marketplace-account.integration.test.ts
pnpm --filter @yummyai/api test:integration -- marketplace-authorization.integration.test.ts
pnpm --filter @yummyai/api test:integration -- marketplace-capability.integration.test.ts
pnpm --filter @yummyai/api test:integration -- marketplace-publication.integration.test.ts
pnpm --filter @yummyai/api test:integration -- marketplace-publication-batch.integration.test.ts
pnpm --filter @yummyai/api test:integration -- marketplace-listing-sync.integration.test.ts
pnpm --filter @yummyai/worker test -- marketplace-publication.processor.test.ts
pnpm --filter @yummyai/worker test -- marketplace-publication-batch.processor.test.ts
pnpm --filter @yummyai/worker test -- marketplace-listing-sync.processor.test.ts
pnpm --filter @yummyai/web test -- publication-batch-workspace.test.tsx listing-channel-operations.test.tsx
pnpm --filter @yummyai/worker test:integration -- marketplace-publication-lease.integration.test.ts
pnpm --filter @yummyai/database test:integration -- tenant-isolation.integration.test.ts
pnpm --filter @yummyai/database exec drizzle-kit check
```

P1-B authorization requires registered marketplace applications. Configure the variables documented in `docs/integration/marketplace-accounts.md`. Real Etsy OAuth requires an exact registered HTTPS callback, so local browser testing uses an approved HTTPS development hostname or tunnel rather than changing the callback to an unregistered localhost URL.

The local API can start without marketplace application credentials. Authorization start fails closed with `503` until the relevant platform variables are configured. Production additionally requires an explicit 32-byte `MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY`.

P1-D Amazon execution is a non-persisting Listings Items validation preview. Etsy execution creates a real provider draft. P1-E starts only through `POST /v1/marketplace-publications/:id/continue`; it performs a real Amazon submission or configures media/inventory/personalization and activates an Etsy draft. Use only approved non-production stores and test Listing data. Uncertain external mutations are intentionally held for reconciliation instead of retried.

The Listing batch workspace creates 2–100 item immutable batches through `/v1/marketplace-publication-batches`. Initial Amazon items still use individual validation previews; continuing a fully validated Amazon batch creates one JSON Listings Feed. Verify the provider report maps every original item by stable `messageId`, then verify successful items reach published status through background reconciliation and remain available as online Listing-sync sources. Never resubmit a batch whose Feed creation or report mapping is uncertain. Etsy continuation keeps ordinary per-item activation semantics. A P1 release candidate needs authorized multi-item Amazon Feed and Etsy batch evidence in addition to the single-item smoke checks.

If initial status polling ends at `sync_pending`, the Worker automatically creates one `publication-reconciliation` job containing only the publication request ID and tenant correlation fields. Keep Redis and the Worker available for the five-hour bounded window: the first safe read starts after fifteen minutes and subsequent attempts retain that spacing. A published/deactivated/failed Provider result closes normally; queue admission failure or twenty inconclusive attempts appends `reconciliation_required`. Do not manually replay the original mutation job.

The Listing `Channels` tab uses the same API and Worker path for site replication, online Listing reconciliation, and approval-trigger automation. A real online sync smoke test requires an already published non-production Listing. Use `read`/`push_price_inventory` for the narrow price and quantity boundary, or `read_full_content`/`push_full_content` for supported approved content plus price and inventory. Inspect the normalized read before any push and use deliberately controlled test values. Full content does not replace media. An interrupted, partial, or uncertain push must remain in `reconciliation_required`; do not manually replay it before a read confirms provider state.

Successful publication and online-sync operations append normalized provider quota evidence to `marketplace_quota_snapshots`. Inspect the latest safe projection on `/stores`: Amazon commonly shows only the operation limit, while Etsy can show per-second and per-day remaining/limit values. `未采集` is correct before a supported successful response. Do not populate release evidence manually, and do not expect raw headers or provider request IDs in the database or API response.

## P2 order-kernel development

Apply migrations, then verify the P2-A contracts, state machine, tenant isolation, PII boundary, identifier-only job payload, and read-only inbox:

```powershell
pnpm --filter @yummyai/database db:migrate
pnpm --filter @yummyai/contracts test -- order.test.ts
pnpm --filter @yummyai/database test:integration
pnpm --filter @yummyai/api test -- order-state-machine.test.ts order-pii-vault.test.ts
pnpm --filter @yummyai/api test:integration -- order.integration.test.ts
pnpm --filter @yummyai/jobs test
pnpm --filter @yummyai/worker test -- order-ingestion.processor.test.ts
pnpm --filter @yummyai/web test -- order-inbox.test.tsx
```

`ORDER_PII_ENCRYPTION_KEY` is an independent base64url-encoded 32-byte production secret. `ORDER_PII_RETENTION_DAYS` defaults to `90` and must be an integer from 1 through 3650. Ordinary `GET /v1/orders` reads never decrypt protected buyer or address fields. Use the purpose-bound fulfillment endpoint only for an authorized operational need; every successful access appends a protected-access audit event.

Migration `0028_p2_order_pii_anonymization` supports the retention drill. Use `POST /v1/orders/:id/protected-details/anonymize` only with `order:pii:anonymize` after the stored expiry. The command requires current order/envelope versions and an idempotency key, removes ciphertext/country data, and records only a reason checksum. Verify that fulfillment reads return `null`, later provider updates do not restore PII, order/event history remains readable, and another tenant receives no evidence that the order exists.

P2-A fixture ingestion is an internal deterministic test seam and has no HTTP route. Real marketplace ingestion and checkpoint advancement begin in P2-B and still require supported provider APIs and authorized test stores.

## P2-C customization and file scanning

The API registers only metadata for a customer file already stored under `tenants/{tenantId}/quarantine/{sha256}/...`. The queue contains only the intake ID. The Worker re-reads the private object, verifies length and SHA-256, streams it to `clamd`, and appends scan evidence. Start or diagnose this boundary with:

```powershell
docker compose --env-file .env -f infra/docker-compose.yml up -d clamav redis minio
docker compose --env-file .env -f infra/docker-compose.yml ps clamav
pnpm --filter @yummyai/contracts test -- customization.test.ts
pnpm --filter @yummyai/jobs test
pnpm --filter @yummyai/worker test -- customization-file-scan.processor.test.ts
pnpm --filter @yummyai/api test:integration -- order-customization.integration.test.ts
pnpm --filter @yummyai/database test:integration -- tenant-isolation.integration.test.ts
pnpm --filter @yummyai/web test -- order-inbox.test.tsx
```

Do not expose port `3310` beyond loopback or a private service network. A `pending` or `failed` intake can be requeued explicitly. Only `clean` evidence can be promoted to the authorized asset domain; `infected`, `unsupported`, or integrity-failed files remain non-production evidence. Signature refreshes change the recorded `signatureVersion`, so acceptance evidence must retain the exact scan event rather than only the current ClamAV database state.

## P2-D supplier routing

Apply migration `0022_p2_supplier_routing`, then verify the deterministic engine, forced-RLS privileges, service persistence, approval/override audit, purchase-order pin, and provider-neutral connector adapters:

```powershell
pnpm --filter @yummyai/database db:migrate
pnpm --filter @yummyai/contracts test -- routing.test.ts
pnpm --filter @yummyai/database test:integration -- tenant-isolation.integration.test.ts
pnpm --filter @yummyai/api test -- order-routing-engine.test.ts production-order.connector.test.ts
pnpm --filter @yummyai/api test:integration -- order-routing.integration.test.ts
pnpm --filter @yummyai/api typecheck
```

The connector tests use injected `fetch` fixtures and do not place supplier orders. A future authorized-account smoke must create a draft first, verify recipient/items/cost in the provider account, and invoke production submission only after explicit approval. Never add Printify/Printful tokens or protected recipient details to job data, logs, screenshots, or fixture snapshots.

## P2-E production, quality, batches, and recovery

The locally complete P2-E slice uses migrations `0023_p2_production_quality` and `0024_p2_production_batch_recovery`:

```powershell
pnpm --filter @yummyai/database db:migrate
pnpm --filter @yummyai/contracts test -- production.test.ts
pnpm --filter @yummyai/database test:integration -- tenant-isolation.integration.test.ts
pnpm --filter @yummyai/api test:integration -- order-production.integration.test.ts
pnpm --filter @yummyai/api typecheck
```

Production instructions and free-form batch, quality, and recovery details share the protected order encryption boundary and must never be queried into ordinary operational lists. Evidence assets must already be in the `authorized` domain with approved rights. Batch completion requires all members to complete. Remake recovery requires completed replacement production and passed QC; reship and compensation recovery require an external reference. This local slice is not a provider production smoke: authorized connector submission, acknowledgement, and reconciliation remain separate online gates.

## P2-F shipment and marketplace writeback

Migration `0025_p2_shipment_writeback` adds versioned shipments, packages, package-line allocation, approval evidence, writeback projections/events, and tracking events. Verify the local slice with:

```powershell
pnpm --filter @yummyai/database db:migrate
pnpm --filter @yummyai/contracts test -- shipment.test.ts
pnpm --filter @yummyai/marketplace-connectors test -- shipment-writeback.test.ts
pnpm --filter @yummyai/api test:integration -- order-shipment.integration.test.ts
pnpm --filter @yummyai/worker test -- shipment-writeback.processor.test.ts
pnpm --filter @yummyai/database test:integration -- tenant-isolation.integration.test.ts
```

`POST /v1/shipments/:shipmentId/writebacks` enqueues only a request ID. The Worker records `dispatched` before the external mutation. Never manually retry a `dispatched` or `reconciliation_required` request; reconcile provider state and append an explicit reconciliation event. Use only authorized test stores for live smoke work. Amazon confirmation follows the official `confirmShipment` endpoint, and Etsy tracking requires `transactions_w`. Provider acceptance moves the order to shipped only after full quantity coverage; delivery requires carrier events for every package.

## P2-G after-sales

Migration `0026_p2_after_sales` adds encrypted customer contacts and decision evidence plus return/replacement projections. Verify the local domain slice with:

```powershell
pnpm --filter @yummyai/database db:migrate
pnpm --filter @yummyai/contracts test -- after-sales.test.ts
pnpm --filter @yummyai/api test:integration -- order-after-sales.integration.test.ts
pnpm --filter @yummyai/database test:integration -- tenant-isolation.integration.test.ts
pnpm --filter @yummyai/api typecheck
```

Do not place customer messages or decision reasons in logs, audit metadata, notifications, or queue payloads. Ordinary after-sales reads intentionally expose checksums instead of plaintext. A recorded refund decision is not proof that a marketplace refund executed; external mutation requires a separate dispatch-before-call and reconciliation workflow.

## P2-G scheduled fulfillment automation

Migration `0027_p2_fulfillment_automation` and queue `fulfillment-automation` add delayed scans, per-tenant hourly quotas, persisted retry limits, cancellation, dead-letter notifications, and manual reconciliation:

```powershell
pnpm --filter @yummyai/database db:migrate
pnpm --filter @yummyai/jobs test
pnpm --filter @yummyai/worker test -- fulfillment-automation.processor.test.ts
pnpm --filter @yummyai/api test:integration -- fulfillment-automation.integration.test.ts
pnpm --filter @yummyai/database test:integration -- tenant-isolation.integration.test.ts
```

Keep Redis running before scheduling a task. Cancellation changes the database projection; a delayed BullMQ delivery that later wakes will be ignored because only `scheduled` tasks can be claimed. `reconciliation_required` and `dead_letter` tasks are not automatically repeated. Use the manual reconciliation route after checking provider/local evidence; rescheduling resets the persisted attempt counter and creates a fresh delayed delivery.

The automation integration suite includes a 25-way concurrent scheduling drill against a quota of 10 and a queue-admission failure drill. It must admit exactly 10 tasks, reject the remainder with the quota response, move the failed admission to `dead_letter`, emit one notification, and never enqueue an automatic replay. These are local deterministic gates; repeat them with the full suite on the exact clean release candidate.

## P3-A inventory kernel

Migration `0029_p3_inventory_kernel` adds warehouses, locations, stock items, lots, append-only movements, rebuildable balances, reservation/event projections, transfer/event projections, and immutable rebuild evidence:

```powershell
pnpm --filter @yummyai/database db:migrate
pnpm --filter @yummyai/database exec drizzle-kit check
pnpm --filter @yummyai/contracts test -- inventory.test.ts
pnpm --filter @yummyai/api test:integration -- inventory.integration.test.ts
pnpm --filter @yummyai/web test -- inventory-workspace.test.tsx erp-sidebar.test.tsx
pnpm --filter @yummyai/api bootstrap:local
```

Restart `pnpm dev` after adding the migration or permissions, then open `http://localhost:3000/inventory`. The local administrator role is refreshed from `Object.values(Permission)` by `bootstrap:local`, so it receives `inventory:read` and `inventory:write`.

Verify both an empty tenant and a populated tenant. The populated path must use authenticated `/v1/inventory` commands rather than UI demo data. At desktop width, balances and recent movements should fit without document or table overflow. At 390 px, the page and navigation must remain within the viewport while wide tables scroll only inside their table containers.

Projection rebuild is an administrative repair command, not a periodic stock mutation. Before using it, retain the movement/reservation evidence and use a unique idempotency key. A rebuild that detects negative physical, in-transit, provider, or virtual stock, or physical below active reservations, fails closed for reconciliation.

## P3-B procurement and replenishment

Migration `0030_p3_procurement_replenishment` adds inventory procurement
requisitions, RFQs, supplier quote versions, versioned inventory purchase orders,
approval events, receipts/rejections, supplier invoices, replenishment policy
versions, and suggestions:

```powershell
pnpm --filter @yummyai/database db:migrate
pnpm --filter @yummyai/database exec drizzle-kit check
pnpm --filter @yummyai/contracts test -- procurement.test.ts
pnpm --filter @yummyai/api test:integration -- procurement.integration.test.ts
pnpm --filter @yummyai/database test:integration -- tenant-isolation.integration.test.ts
pnpm --filter @yummyai/web test -- procurement-workspace.test.tsx erp-sidebar.test.tsx
pnpm --filter @yummyai/api bootstrap:local
```

Restart the API and Web processes after applying the migration and refreshing
local permissions, then open `http://localhost:3000/procurement`. The local
administrator receives `procurement:read`, `procurement:write`, and
`procurement:approve`; ordinary production roles must receive them explicitly.

Populate the page only through authenticated `/v1/inventory`, `/v1/sourcing`,
and `/v1/procurement` routes. Verify a complete requisition, RFQ, quote,
purchase-order approval, receipt, invoice, policy, and suggestion chain. Include
one receipt or invoice variance and confirm it remains
`reconciliation_required`. Confirm that accepted receipt quantity creates an
inventory lot and movement, while a replenishment suggestion does not create or
approve a purchase order.

At desktop and 390 px widths, the fifteen navigation items must remain present, the
document must not overflow horizontally, and the purchase-order table may scroll
only inside its table container. Verify explicit empty, unauthorized, forbidden,
failed, and populated states without procurement demo data.

## P3-C channel inventory and allocation

Migration `0031_p3_channel_inventory` adds immutable provider snapshots and
checkpoints, versioned allocation policies, immutable allocation runs and
channel projections, and append-only external-mutation reconciliation:

```powershell
pnpm --filter @yummyai/database db:migrate
pnpm --filter @yummyai/database exec drizzle-kit check --config drizzle.config.ts
pnpm --filter @yummyai/contracts test -- channel-inventory.test.ts
pnpm --filter @yummyai/marketplace-connectors test -- inventory.test.ts
pnpm --filter @yummyai/api exec vitest run --config vitest.integration.config.ts src/channel-inventory/channel-inventory.integration.test.ts
pnpm --filter @yummyai/worker test -- marketplace-listing-sync.processor.test.ts
pnpm --filter @yummyai/web test -- channel-inventory-workspace.test.tsx erp-sidebar.test.tsx
pnpm --filter @yummyai/api bootstrap:local
```

Restart API, Worker, and Web after applying the migration and refreshing the
local role, then open `http://localhost:3000/channel-inventory`. The local
administrator receives `channel_inventory:read`, `channel_inventory:write`, and
`channel_inventory:reconcile`. Production roles must receive them explicitly.

Use authenticated provider connector jobs or `/v1/channel-inventory/snapshots`
with normalized evidence. Do not enter guessed FBA, FBM, 3PL, supplier, or
virtual quantities. After each new snapshot or policy version, run the current
allocation policy before requesting a Listing inventory push. A stale
projection is expected to fail closed.

At desktop and 390 px widths, all fifteen navigation items must remain present
and the document must not overflow horizontally. The evidence and projection
tables may scroll only within their table containers. Verify empty,
unauthorized, forbidden, failed, populated, and open-reconciliation states.

## P3-D finance and profit

Migration `0032_p3_finance_profit` adds immutable statements, normalized facts,
historical FX, versioned profit definitions, immutable runs, and per-fact
contributions:

```powershell
pnpm --filter @yummyai/database db:migrate
pnpm --filter @yummyai/database exec drizzle-kit check
pnpm --filter @yummyai/contracts test -- finance.test.ts
pnpm --filter @yummyai/marketplace-connectors test -- finance.test.ts
pnpm --filter @yummyai/api test:integration -- finance.integration.test.ts
pnpm --filter @yummyai/web test -- finance-workspace.test.tsx erp-sidebar.test.tsx
pnpm --filter @yummyai/api bootstrap:local
```

Restart API and Web after migration and permission refresh, then open
`http://localhost:3000/finance`. The local administrator receives
`finance:read`, `finance:write`, and `finance:review`; production roles must
receive them explicitly.

Populate the workspace through authenticated finance routes or authorized
provider ingestion. Verify one complete multi-currency calculation and separate
missing-fact, missing-FX, and unclassified-fact runs. Complete values must match
the pinned statement and FX evidence exactly; incomplete totals must display as
missing, never zero.

At desktop and 390 px widths, all fifteen navigation items must remain present
and the document must not overflow horizontally. Wide finance tables may scroll
only inside their table containers. Real Amazon/Etsy settlement retrieval is a
separate authorized-provider acceptance gate.

## P3-E supplier performance

Migration `0033_p3_supplier_performance` adds versioned KPI definitions,
immutable scorecard runs, and one immutable evidence row for each of the seven
supplier KPIs:

```powershell
pnpm --filter @yummyai/database db:migrate
pnpm --filter @yummyai/database exec drizzle-kit check
pnpm --filter @yummyai/contracts test -- supplier-performance.test.ts
pnpm --filter @yummyai/api test -- supplier-performance.service.test.ts
pnpm --filter @yummyai/api test:integration -- supplier-performance.integration.test.ts
pnpm --filter @yummyai/web test -- supplier-performance-workspace.test.tsx erp-sidebar.test.tsx
pnpm --filter @yummyai/api bootstrap:local
```

Restart API and Web after migration and permission refresh, then open
`http://localhost:3000/supplier-performance`. The local administrator receives
`supplier_performance:read` and `supplier_performance:review`; production roles
must receive them explicitly.

Populate the workspace through authenticated production, quality, procurement,
invoice, capacity, and supplier-performance routes. Create a versioned
definition before calculating a scorecard. Verify the evaluation window,
evidence cutoff, raw numerator/denominator, sample count, evidence references,
and input checksum remain pinned. Repeating the same idempotency key with changed
content must conflict.

Verify `exclude`, `zero`, and `incomplete` missing-data policies with insufficient
samples. The interface must display missing evidence explicitly and must not
invent a total. At desktop and 390 px widths, all fifteen navigation items must
remain present, the document must not overflow horizontally, and wide scorecard
tables may scroll only inside their containers. A scorecard must not update
supplier routing, capacity, procurement, or production state.

## P3-F advertising and VOC

Migration `0034_p3_customer_intelligence` adds immutable advertising reports and metric lines, identity-redacted customer signal facts, versioned VOC definitions, immutable analyses and theme metrics, and review-only recommendations:

```powershell
pnpm --filter @yummyai/database db:migrate
pnpm --filter @yummyai/database exec drizzle-kit check
pnpm --filter @yummyai/contracts test -- customer-intelligence.test.ts
pnpm --filter @yummyai/api test:integration -- customer-intelligence.integration.test.ts
pnpm --filter @yummyai/web test -- customer-intelligence-workspace.test.tsx erp-sidebar.test.tsx
pnpm --filter @yummyai/api bootstrap:local
```

Restart API and Web after migration and permission refresh, then open `http://localhost:3000/customer-intelligence`. The local administrator receives `customer_intelligence:read`, `customer_intelligence:write`, and `customer_intelligence:review`; production roles must receive them explicitly.

Populate the workspace only through authenticated advertising and customer-intelligence routes. Verify source currency, attribution window, metric totals, source evidence, consent basis, redaction, definition version, analysis window, signal IDs, and review events. At desktop and 390 px widths, all fifteen navigation items must remain present and document overflow must remain absent; wide tables may scroll only inside their containers.

## P3-G forecasting and open integrations

Migrations `0035_p3_forecasting_operations` and
`0036_p3_api_client_authentication` add pinned forecasts, versioned operating
metrics, reconciliation, scoped API clients, signed Webhook evidence, and the
restricted authentication lookup:

```powershell
pnpm --filter @yummyai/database db:migrate
pnpm --filter @yummyai/database exec drizzle-kit check
pnpm --filter @yummyai/contracts test -- planning.test.ts integration.test.ts
pnpm --filter @yummyai/api test:integration -- planning.integration.test.ts integration.integration.test.ts
pnpm --filter @yummyai/worker test:integration
pnpm --filter @yummyai/web test -- operating-cockpit.test.tsx erp-sidebar.test.tsx
pnpm --filter @yummyai/api bootstrap:local
```

Restart API, Worker, and Web, then open
`http://localhost:3000/operating-cockpit`. The local administrator receives the
forecast, operations, and integration permissions through the normal local
bootstrap. Production roles must receive write, review, reconcile, and manage
permissions explicitly.

`INTEGRATION_SECRET_ENCRYPTION_KEY` is a base64url-encoded 32-byte production
secret. It must be identical in API and Worker deployments and distinct from
marketplace, PII, and model-provider keys. Local development may leave it empty
and use the domain-separated `LOCAL_OIDC_CLIENT_SECRET` fallback. Restart both
processes after changing it; existing encrypted endpoint secrets require the old
key until they are explicitly rotated.

Create Webhook endpoints only for HTTPS URLs. `http://localhost`,
`http://127.0.0.1`, and `http://[::1]` are accepted for local sinks. The
`webhook-delivery` queue requires Redis and the Worker. Inspect safe delivery
status through `/v1/integrations/workspace`; response bodies and secrets are
intentionally absent.

If the API stops after persisting an event but before queue admission, the
workspace can show an original delivery stuck in `pending` with zero attempts.
Restart API and Worker, then repeat the exact publish request with the same
idempotency key and unchanged payload. The API resubmits only pending deliveries
and BullMQ deduplicates them by delivery ID. Do not use the manual dead-letter
replay route for this state.

Verify `/operating-cockpit` at desktop and 390 px widths. All fifteen navigation
items must remain present, document-level horizontal overflow must be absent,
and forecast/delivery tables may scroll only inside their table containers.
Before release, run the P3-G API/Worker integration suites, a fresh-database
migration, the backup/restore drill, and the full root gates on the exact clean
candidate.

After committing the exact clean candidate, run `pnpm build`, `pnpm --filter @yummyai/extension zip`, and `pnpm release:manifest` to create `output/release-candidate/release-candidate-manifest.json`. Local generation fails when tracked changes are present or either Chrome/Edge ZIP is missing. The manifest records their SHA-256 checksums, the exact commit, Node/pnpm versions, and latest migration. It is code-verification evidence only; authorized-provider acceptance and backup/restore evidence remain separate release gates.
