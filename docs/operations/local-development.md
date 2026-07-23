# Local development

## Prerequisites

- Node.js 24.17.x and pnpm 11.10.x
- Docker Desktop with Compose v2
- Chrome or Edge for extension smoke tests

## Start

```powershell
Copy-Item .env.example .env
docker compose --env-file .env -f infra/docker-compose.yml up -d
pnpm install --frozen-lockfile
pnpm --filter @yummyai/database db:migrate
pnpm dev
```

`pnpm dev` starts the publication Worker together with the API and Web application. To run only the Worker while diagnosing P1 publication jobs:

The Web application owns `http://localhost:3000`. WXT uses `http://localhost:3001` for extension hot reload so `localhost` cannot resolve to the wrong development server.

The root `dev` script loads `.env` through Node before starting Turbo. `turbo.json` explicitly passes the Web server's API and local OIDC variable names to development tasks; keep `pnpm check:rules` green when that set changes. API and Worker scripts also load the same root `.env` directly. Do not put provider credentials into browser-visible `NEXT_PUBLIC_*` variables.

```powershell
pnpm --filter @yummyai/worker start
```

The Worker uses `DATABASE_URL`, `REDIS_URL`, the marketplace application variables, the same `MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY` as the API, and `CLAMAV_HOST`/`CLAMAV_PORT`/`CLAMAV_TIMEOUT_MS` for quarantined customer-file scanning. The API uses a separate `ORDER_PII_ENCRYPTION_KEY` for protected order details. In non-production local development only, both encryption domains derive separate fallback keys from `LOCAL_OIDC_CLIENT_SECRET`.

Default endpoints are PostgreSQL `5432`, Redis `6379`, MinIO `9000/9001`, Keycloak `8081`, ClamAV `3310` (loopback only), and OTLP `4317/4318`. Change host ports in `.env` when they collide; keep container ports unchanged. ClamAV needs several GiB of RAM while loading and refreshing signatures, so allocate enough Docker Desktop memory before enabling P2-C file scans.

## Health and diagnostics

```powershell
docker compose --env-file .env -f infra/docker-compose.yml ps
docker compose --env-file .env -f infra/docker-compose.yml logs --tail=100 postgres redis minio keycloak clamav otel-collector
pnpm --filter @yummyai/database exec drizzle-kit check
```

Use `DASHBOARD_DEMO_MODE=1`, `ANALYSIS_DEMO_MODE=1`, `PRODUCT_DEMO_MODE=1`, `DESIGN_DEMO_MODE=1`, and `LISTING_DEMO_MODE=1` only for UI development. Never set demo flags in deployed environments.

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
pnpm --filter @yummyai/worker test -- marketplace-publication.processor.test.ts
pnpm --filter @yummyai/worker test -- marketplace-listing-sync.processor.test.ts
```

P1-B authorization requires registered marketplace applications. Configure the variables documented in `docs/integration/marketplace-accounts.md`. Real Etsy OAuth requires an exact registered HTTPS callback, so local browser testing uses an approved HTTPS development hostname or tunnel rather than changing the callback to an unregistered localhost URL.

The local API can start without marketplace application credentials. Authorization start fails closed with `503` until the relevant platform variables are configured. Production additionally requires an explicit 32-byte `MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY`.

P1-D Amazon execution is a non-persisting Listings Items validation preview. Etsy execution creates a real provider draft. P1-E starts only through `POST /v1/marketplace-publications/:id/continue`; it performs a real Amazon submission or configures media/inventory/personalization and activates an Etsy draft. Use only approved non-production stores and test Listing data. Uncertain external mutations are intentionally held for reconciliation instead of retried.

The Listing `Channels` tab uses the same API and Worker path for site replication, online price/inventory reconciliation, and approval-trigger automation. A real online sync smoke test requires an already published non-production Listing. Run `read` first, verify the normalized snapshot, then use `push_price_inventory` only with deliberately controlled test price/quantity values. An uncertain push must remain in `reconciliation_required`; do not manually replay the job before a read confirms provider state.

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

At desktop and 390 px widths, the twelve navigation items must remain present, the
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

At desktop and 390 px widths, all twelve navigation items must remain present
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

At desktop and 390 px widths, all twelve navigation items must remain present
and the document must not overflow horizontally. Wide finance tables may scroll
only inside their table containers. Real Amazon/Etsy settlement retrieval is a
separate authorized-provider acceptance gate.
