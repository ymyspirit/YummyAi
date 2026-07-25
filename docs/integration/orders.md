# Order integration

P2-A provides a provider-neutral, tenant-isolated order kernel. P2-B adds incremental Amazon/Etsy page adapters, bounded orchestration, immutable materialization, catalog-version pins, checkpoint evidence, and a PII-free risk inbox. P2-C adds pinned customization mapping, quarantined customer files, malware-scan evidence, immutable proof versions, and explicit customer decisions. P2-D adds versioned supplier evidence, deterministic allocation, approval/override evidence, and immutable purchase-order versions. Provider HTTP adapters are fixture-tested but have not been run against authorized stores or supplier accounts; real polling and production submission remain explicit acceptance gates.

## Data boundary

The ordinary order projection contains provider identity, workflow state, side state, integer-minor-unit totals, product lines, address availability/country, event sequence, and timestamps. It intentionally excludes buyer name, email, phone, address lines, postal code, and customization values.

Protected buyer, shipping-address, and customization details are stored as one AES-256-GCM envelope in `order_protected_details`. Production requires an explicit base64url-encoded 32-byte `ORDER_PII_ENCRYPTION_KEY`. `ORDER_PII_RETENTION_DAYS` controls the stored expiry timestamp and defaults to 90 days.

`GET /v1/orders/:id/fulfillment?purpose=...` is the only P2-A HTTP read that decrypts this envelope. It requires `order:pii:read`, accepts only `fulfillment`, `customer_support`, `fraud_review`, `legal`, or `retention`, and appends a tenant-scoped access event before plaintext is returned. Do not call it from the ordinary order inbox.

`POST /v1/orders/:id/protected-details/anonymize` is the irreversible retention command. It requires the separate `order:pii:anonymize` permission, the current order event sequence and envelope version, an idempotency key, and an operator reason. It fails before `retentionExpiresAt`. On success it removes the ciphertext and country projection, marks the envelope anonymized, and appends checksum-only event/audit evidence; later provider updates cannot repopulate the protected fields.

## API

All routes derive tenant context from authenticated membership:

| Method | Route | Permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/v1/orders` | `order:read` | Safe list with optional marketplace-account, platform, workflow, side-state, and limit filters |
| `GET` | `/v1/orders/ingestion/runs` | `order:read` | Safe ingestion counts, checkpoint versions, status, and static risk diagnostics |
| `GET` | `/v1/orders/customizations` | `order:read` | Safe tenant customization queue; optional `orderId` filter |
| `GET` | `/v1/orders/routing` | `order:read` | Safe tenant routing-decision queue; optional `orderId` filter |
| `GET` | `/v1/orders/:id/customizations/:requirementId` | `order:read` | Safe latest customization-version summary |
| `GET` | `/v1/orders/:id` | `order:read` | Safe order and line projection |
| `GET` | `/v1/orders/:id/events` | `order:read` | Ordered immutable domain events |
| `GET` | `/v1/orders/:id/exceptions` | `order:read` | Current exception projections backed by append-only events |
| `GET` | `/v1/orders/exceptions` | `order:read` | Tenant exception queue with optional open/resolved filter |
| `GET` | `/v1/orders/:id/fulfillment` | `order:pii:read` | Purpose-bound protected details |
| `POST` | `/v1/orders/:id/protected-details/anonymize` | `order:pii:anonymize` | Irreversibly remove expired protected details with optimistic and audit evidence |
| `POST` | `/v1/orders/:id/transitions` | `order:write` | Optimistic main-state transition |
| `POST` | `/v1/orders/:id/side-state` | `order:write` | Hold, release, or cancel without rewriting main history |
| `POST` | `/v1/orders/:id/exceptions` | `order:write` | Open an operational exception |
| `POST` | `/v1/orders/:id/exceptions/:exceptionId/resolve` | `order:write` | Append exception resolution |
| `POST` | `/v1/orders/:id/customizations` | `order:write` | Map protected provider values to the pinned schema and select a fulfillment path |
| `POST` | `/v1/orders/:id/customizations/:requirementId/versions` | `order:write` | Append a remapped version using optimistic version matching |
| `POST` | `/v1/orders/:id/customizations/:requirementId/versions/:versionId/files` | `order:write`, `asset:write` | Register tenant-quarantine metadata and enqueue malware scanning |
| `POST` | `/v1/orders/:id/customizations/:requirementId/files/:intakeId/scan` | `order:write`, `asset:write` | Requeue a pending or failed scan without putting file metadata in the job |
| `POST` | `/v1/orders/:id/customizations/:requirementId/files/:intakeId/promote` | `order:write`, `asset:promote` | Copy a clean file into the authorized domain and record customer-provided rights |
| `POST` | `/v1/orders/:id/customizations/:requirementId/proofs` | `order:write` | Append an immutable proof version after customization/file/design gates pass |
| `POST` | `/v1/orders/:id/proofs/:proofId/decisions` | `order:write` | Record one replay-safe final customer decision |
| `POST` | `/v1/orders/:id/routing` | `order:write` | Evaluate one pinned order line against an explicit routing-policy version |
| `GET` | `/v1/sourcing/suppliers` | `order:read` | List tenant fulfillment suppliers |
| `POST` | `/v1/sourcing/suppliers` | `order:write` | Create a manual, Printify, or Printful supplier projection |
| `POST` | `/v1/sourcing/capability-snapshots` | `order:write` | Append supplier SKU/process/region/quality evidence |
| `POST` | `/v1/sourcing/quotes` | `order:write` | Append a currency, cost, MOQ, lead-time, and validity quote |
| `POST` | `/v1/sourcing/capacity-windows` | `order:write` | Append capacity-window evidence |
| `POST` | `/v1/sourcing/routing-policies` | `order:write` | Append an immutable weighted policy version |
| `GET` | `/v1/sourcing/routing-decisions/:decisionId` | `order:read` | Read a decision with ranked candidates and event history |
| `POST` | `/v1/sourcing/routing-decisions/:decisionId/override` | `order:write` | Select an eligible candidate with mandatory actor/reason evidence and return to review |
| `POST` | `/v1/sourcing/routing-decisions/:decisionId/review` | `order:write` | Approve/reject with optimistic decision-version matching |
| `GET` | `/v1/production/orders` | `order:read` | List production projections with optional `orderId` filter |
| `GET` | `/v1/production/orders/:productionOrderId` | `order:read` | Safe production versions, milestones, inspections, and defect codes without encrypted notes |
| `POST` | `/v1/orders/:id/production` | `order:write` | Create idempotent production work from approved routing and the current purchase-order version |
| `POST` | `/v1/production/orders/:productionOrderId/milestones` | `order:write` | Append an evidence-bearing milestone using optimistic projection versioning |
| `POST` | `/v1/production/orders/:productionOrderId/inspections` | `order:write` | Append a pinned-standard inspection and immutable defects |
| `POST` | `/v1/production/batches` | `order:write` | Group planned production orders for one supplier into an idempotent batch |
| `GET` | `/v1/production/batches/:batchId` | `order:read` | Read a safe batch projection, immutable members, and ordered lifecycle events |
| `POST` | `/v1/production/batches/:batchId/events` | `order:write` | Append a batch lifecycle event using optimistic projection versioning |
| `POST` | `/v1/production/quality-standards` | `order:write` | Append an immutable weighted quality-standard version |
| `POST` | `/v1/production/recoveries` | `order:write` | Open remake, reship, or cancellation-compensation evidence; remake creates a child production order |
| `GET` | `/v1/production/recoveries/:recoveryCaseId` | `order:read` | Read a safe recovery projection and ordered resolution evidence |
| `POST` | `/v1/production/recoveries/:recoveryCaseId/events` | `order:write` | Start, resolve, or cancel a recovery with optimistic and type-specific evidence gates |
| `GET` | `/v1/shipments` | `order:read` | List shipment projections with optional `orderId` filter |
| `POST` | `/v1/orders/:id/shipments` | `order:write` | Create a draft shipment and immutable version with split/combined package allocation |
| `GET` | `/v1/shipments/:shipmentId` | `order:read` | Read safe versions, packages, allocations, reviews, tracking, and writeback projections |
| `POST` | `/v1/shipments/:shipmentId/versions` | `order:write` | Append a new immutable shipment version using optimistic current-version matching |
| `POST` | `/v1/shipments/:shipmentId/versions/:versionId/reviews` | `order:write` | Approve/reject the current version with encrypted reviewer reason evidence |
| `POST` | `/v1/shipments/:shipmentId/writebacks` | `order:write` | Queue marketplace confirmation for the current approved version |
| `POST` | `/v1/shipments/:shipmentId/tracking-events` | `order:write` | Append normalized carrier evidence and open delay/exception alerts |
| `GET` | `/v1/shipments/writebacks/:requestId` | `order:read` | Read the writeback projection and ordered acknowledgement events |
| `POST` | `/v1/shipments/writebacks/:requestId/events` | `order:write` | Record or reconcile a writeback outcome; accepted outcomes require an external reference |
| `GET` | `/v1/after-sales-cases` | `order:read` | List safe case projections, optionally filtered by `orderId` |
| `POST` | `/v1/orders/:id/after-sales-cases` | `order:write` | Open an idempotent case with an encrypted summary |
| `GET` | `/v1/after-sales-cases/:caseId` | `order:read` | Read safe contact checksums, decision versions, returns, replacements, and responsibility evidence |
| `POST` | `/v1/after-sales-cases/:caseId/contacts` | `order:write` | Append an encrypted inbound, outbound, or internal contact record |
| `POST` | `/v1/after-sales-cases/:caseId/decisions` | `order:write` | Append an optimistic refund, return, replacement, rejection, or no-action decision |
| `POST` | `/v1/after-sales-cases/:caseId/return-shipments` | `order:write` | Create a return from the current approved return-required decision |
| `POST` | `/v1/after-sales-cases/:caseId/return-shipments/:returnShipmentId/events` | `order:write` | Append replay-safe return tracking and resolve only on delivery |
| `POST` | `/v1/after-sales-cases/:caseId/replacements` | `order:write` | Link a distinct tenant order to an approved replacement decision without lineage cycles |
| `POST` | `/v1/after-sales-cases/:caseId/responsibility-evidence` | `order:write` | Append encrypted responsibility evidence with an optional approved authorized asset |
| `GET` | `/v1/fulfillment-automations` | `order:read` | List the latest 100 scheduled/recovery task projections |
| `POST` | `/v1/fulfillment-automations` | `order:write` | Schedule an identifier-only delayed attention, writeback-reconciliation, or PII-retention scan |
| `GET` | `/v1/fulfillment-automations/:taskId` | `order:read` | Read safe task and append-only event evidence |
| `POST` | `/v1/fulfillment-automations/:taskId/cancel` | `order:write` | Cancel a scheduled task with optimistic version and encrypted reason evidence |
| `POST` | `/v1/fulfillment-automations/:taskId/reconcile` | `order:write` | Complete, cancel, or reschedule a failed/dead-letter/uncertain task manually |
| `PATCH` | `/v1/fulfillment-automations/policy` | `order:write` | Set tenant hourly quota and maximum attempts |

Transition and side-state commands require the current `expectedSequence` plus an idempotency key. A stale sequence returns a conflict; replaying a completed command with the same key does not append another event.

## Ingestion seam

Order ingestion is an internal service boundary rather than a public write endpoint. Provider adapters pass normalized safe fields, a redacted source object, and protected details separately for immediate encryption. Source keys resembling buyer, recipient, name, email, phone, address, postal, or ZIP data must be `null` or `[REDACTED]`.

The `order-ingestion` queue contract carries only `snapshotId` and `accountId`; tenant context comes from the job envelope. Tokens, provider payloads, buyer fields, addresses, and customization values are rejected as extra properties. Provider HTTP calls obtain credentials through a scoped credential accessor at execution time; secrets and provider payloads never enter queue data.

### P2-B incremental contract

`@yummyai/marketplace-connectors` now owns the provider-neutral order page adapter, sync request, page metadata, checkpoint planner, and risk diagnostics:

- Initial backfill is bounded to 1–30 days, pages to 1–100 records, and one run to at most 50 pages.
- A completed checkpoint is overlapped by five minutes by default so late provider updates can be replayed safely; the configured backfill floor still caps the window.
- A non-final page advances only the opaque cursor. The high-water timestamp advances only after the final page and can never move backwards.
- Page results distinguish collected records from the provider's optional reported count and retain source version and fetch/high-water timestamps.
- Diagnostics use static, PII-free messages for duplicate delivery, address gaps, missing customization, unsupported mapping, cancellation requests, and stale provider data.

The provider normalizers target Amazon Orders API `v2026-01-01`, Amazon `ORDER_CHANGE` payload version 1.0, and Etsy Open API v3 receipts/transactions. They validate provider payloads before producing `NormalizeOrderInput`, keep only identifiers, states, timestamps, versions, and line references in redacted evidence, and route buyer/address/customization fields to protected details. `ORDER_CHANGE` produces an enrichment reference because its high-level event does not contain all money and product fields required by the normalized order.

`AmazonOrdersAdapter` sends bounded `searchOrders` requests with the minimum required included-data sets and opaque pagination tokens. `EtsyReceiptsAdapter` uses `min_last_modified`/`max_last_modified`, stable updated-time ordering, and offset pagination. Both normalize authorization, validation, rate-limit, retryable upstream, and terminal errors; a `Retry-After` value is returned to the job boundary instead of performing a blind retry. `executeOrderSync` rejects repeated cursors or source-version drift, enforces the page bound, materializes each delivery idempotently, and returns a completed or partial summary. Live authorized pagination and refresh-token-rotation persistence remain pending acceptance work.

`OrderSyncCoordinator` starts one account/platform/stream run, verifies the persisted checkpoint version, executes the bounded adapter loop, materializes immutable evidence, and advances the checkpoint only when the summary commits. Failures finalize the run with a static error code without advancing the checkpoint. A partial run retains an opaque cursor and the previous high-water mark for the next run.

## Persistence and replay

- Provider order identity is unique per tenant, account, platform, and external order ID.
- Delivery identity is unique per tenant, account, platform, and external event ID.
- Source snapshots, lines, external references, order events, exception identities/events, and protected-access events are append-only for the application role.
- A new external event for an existing order appends another source snapshot and `provider_update_received` event before updating the current provider-status projection. When protected details are present and have not been anonymized, their encrypted envelope advances by version; anonymized data is never repopulated. Replaying the same external event is a no-op.
- `order_line_catalog_links` pins the active SKU and approved Listing version found during first materialization. Catalog changes never rewrite that link; unresolved lines enter the risk inbox.
- `order_ingestion_runs` records collected/reported/duplicate/risk counts and start/end checkpoint versions. A partial unique index and transaction advisory lock allow only one running record per account/platform/stream.
- `order_ingestion_risks` and catalog links are append-only. `orders`, ingestion-run finalization, protected-detail retention state, and connector checkpoints are the mutable projections. Migration `0028_p2_order_pii_anonymization` makes the ciphertext nullable solely so an expired envelope can be irreversibly removed without deleting order identity or history.
- Main workflow and exception status remain independently queryable.

## P2-C customization and approval

Initialization decrypts protected order details only for the fixed `fulfillment` purpose, maps marketplace personalization/variation/buyer text/file references to the catalog schema captured on the requirement, and immediately re-encrypts the mapped values. Public summaries expose only field keys, completeness, workflow path, status, version, and deadlines. Remapping always uses the pinned schema snapshot, requires the latest expected version number, and appends a new encrypted version only when the checksum changes.

Customer files enter `tenants/{tenantId}/quarantine/...`; original buyer filenames are not persisted. A `customization-file-scan` job contains only the intake ID. The Worker reads the object through tenant/domain authorization, verifies byte length and SHA-256, sends bytes to `clamd` with the INSTREAM protocol, and appends scan engine/signature/result evidence. Only `clean` files can be copied into the authorized domain; infected, unsupported, failed, or unscanned files cannot satisfy the proof gate. The TCP scanner must remain loopback/private because the ClamAV protocol has no transport authentication.

`template_ready` can create a proof without a design; `designer_required` and `customer_approval_required` require an approved immutable design version. Customer proofs remain `awaiting_customer` until one serialized final decision is recorded. Expiry appends a `timed_out` decision and opens a `customer_timeout` exception; it never implies approval. Proven customization versions cannot accept additional files, and production/routing transitions re-check the latest requirement statuses.

The `/orders` Web page reads `GET /v1/orders`, `GET /v1/orders/ingestion/runs`, and `GET /v1/orders/customizations`. It shows checkpoint absence, failure, partial state, count drift, static risks, customization completeness, missing field keys, pinned version, deadline, and proof-gate status explicitly. Desktop and 390 px browser checks show no document-level horizontal overflow; unavailable provider values are never fabricated.

## P2-D supplier routing and purchase

Supplier capability, quote, capacity, and routing-policy versions are immutable inputs. An evaluation records all ranked candidates, exclusion codes, dimension scores, selected supplier, policy ID/version, and a SHA-256 checksum over canonical inputs. Eligibility is checked before score order. Ties resolve by total score, unit cost, lead time, then supplier ID, so repeating the same pinned input is deterministic.

Cost and quality-risk thresholds require review. A manual override can select only an eligible candidate recorded by that evaluation and always creates an `overridden` event containing the authenticated actor, reason code, and reason before returning the decision to `pending_approval`. An approved decision advances a supplier-grouped purchase order through a new immutable version; it never edits a prior line/cost/decision snapshot. Production is blocked until the latest decision for every line is approved and covered by current approved purchase-order versions.

`PrintifyProductionOrderConnector` and `PrintfulProductionOrderConnector` share one protected production-order contract. Both separate draft creation from explicit submission. Printify uses `POST /v1/shops/{shop_id}/orders.json` followed by `send_to_production`; Printful creates with `confirm=false` and later calls `/orders/{id}/confirm`. Credentials are constructor-scoped, errors expose only provider/status, and raw provider bodies containing recipient data are not included in exceptions. These adapters have deterministic HTTP tests only; no supplier order has been submitted during local P2-D acceptance.

## P2-E production and quality

Production work pins an approved routing decision, the current approved purchase-order version, quantity, optional approved design version, authorized production asset IDs, and expected completion. Free-form production instructions, milestone notes, defect details, and recovery reasons are encrypted; public projections expose only checksums and structured codes. Milestones follow `planned -> submitted -> acknowledged -> in_production -> completed` with explicit failed/cancellation branches and optimistic projection versions.

Quality standards are append-only weighted versions. An inspection pins one standard, checks its supplier/SKU scope and minimum score, validates all evidence assets against the authorized/approved-rights domain, and appends defects with severity, responsibility, and disposition. A failed inspection moves the production projection to `quality_hold` and opens a separate `quality` exception. A remake copies the immutable production inputs into a new child production order while leaving the original unchanged. `in_production -> awaiting_quality_control` requires every line's latest production work to be complete; `awaiting_quality_control -> awaiting_shipment` additionally requires a passed latest inspection.

Supplier batches have immutable membership and an optimistic lifecycle. A batch cannot complete until all member production orders have completed. Recovery transitions are append-only: remake resolution requires completed replacement production plus passed QC, while reship and cancellation-compensation resolution require an external evidence reference. Migrations `0023_p2_production_quality` and `0024_p2_production_batch_recovery` and their service/API paths are locally implemented. Authorized Printify/Printful acknowledgement and reconciliation remain an online acceptance gate.

## P2-F shipment, tracking, and writeback

Shipment content is immutable by version. A version pins ship/promised/estimated dates, ship-from country, carrier service, tracking, optional authorized label asset/cost, and package-to-order-line quantities. Multiple packages may share one line and one package may contain multiple lines; approval sums all active approved versions and rejects over-allocation. Reviewer free text is encrypted while reason codes and checksums remain operationally visible.

Only the current approved version can create an identifier-only `shipment-writeback` job. The Worker appends `dispatched` before calling the marketplace connector. A lost response, `5xx`, or interrupted dispatched job becomes `reconciliation_required`; automatic mutation replay is blocked. An accepted or manually reconciled outcome requires an external acknowledgement and advances the order to `shipped` only when acknowledged versions cover every ordered quantity. Marketplace acceptance is not delivery.

Amazon uses Orders v0 `POST /orders/v0/orders/{orderId}/shipmentConfirmation`; Etsy uses `POST /v3/application/shops/{shop_id}/receipts/{receipt_id}/tracking` with `transactions_w`. Fixture connectors contain no credentials in payloads or error results. Normalized tracking is append-only and idempotent by provider event ID. Delay or carrier exception evidence opens a separate logistics exception. The order reaches `completed` only when every acknowledged package quantity has latest delivered evidence. Real authorized writes and provider reconciliation remain online acceptance gates.

Official references: [Amazon confirmShipment](https://developer-docs.amazon.com/sp-api/reference/confirmshipment), [Etsy Open API v3 reference](https://developers.etsy.com/documentation/reference/), and [Etsy fulfillment tutorial](https://developers.etsy.com/documentation/tutorials/fulfillment/).

## P2-G after-sales

Migration `0026_p2_after_sales` separates mutable case/return projections from append-only customer contacts, decision versions, tracking events, replacement lineage, and responsibility evidence. Free-form summaries, messages, reasons, and evidence details are encrypted with the order PII vault; ordinary reads expose structured codes and checksums only.

Refund decisions use integer minor units, must match the order currency, cannot exceed the order total, and distinguish exact full refunds from strictly smaller partial refunds. Return creation requires the current approved decision to require a return. A return resolves only after valid tracking progression reaches delivery. Replacement links require the current approved replacement decision, a distinct tenant-owned order, and an acyclic lineage. Optional labels and responsibility attachments must already belong to the authorized asset domain with approved rights.

This local slice records refund decisions but does not execute marketplace refund mutations. Amazon's supported route is an Order Adjustments Feed, which needs explicit order-line and charge-component allocation not present in the current decision contract. Etsy's Open API v3 payments/ledger operations are read-only. YummyAI therefore fails closed instead of synthesizing a provider refund request; allocation modeling, external evidence reconciliation, and authorized acceptance remain explicit gates. See [Amazon Order feed types](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/order-feed-type-values) and [Etsy payments](https://developers.etsy.com/documentation/tutorials/payments/).

### Scheduled fulfillment automation

Migration `0027_p2_fulfillment_automation` adds tenant quota policy, mutable task projections, and append-only events. Queue envelopes contain only `taskId`; BullMQ delay/backoff controls execution timing while the database remains authoritative for cancellation and attempt counts. Initial replay keeps one delivery ID, while manual rescheduling creates a fresh delivery ID so a retained BullMQ job cannot suppress recovery. A retryable failure returns the task to `scheduled`; exhausting the persisted attempt budget moves it to `dead_letter` and routes a notification to the requesting operator.

Attention scans count overdue production, uncertain shipment writebacks, lost returns, and internally actionable after-sales cases. Shipment-reconciliation and PII-retention scans identify work but never invent a provider outcome or automatically destroy protected data. Non-zero findings enter `reconciliation_required`, create a notification, and require an explicit optimistic manual reconciliation. Operator reasons are encrypted and ordinary event reads expose only their checksums.
