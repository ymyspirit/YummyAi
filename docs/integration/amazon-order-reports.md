# Amazon order report intake

The manual intake workspace is `/orders/import`, linked from **订单履约 → 导入亚马逊报告**. An operator selects an existing Amazon account and marketplace, then uploads Seller Central's tab-delimited TXT report. An account awaiting marketplace authorization can be used for manual intake; disabled or revoked accounts cannot. This path does not call marketplace order, publication, shipment, or inventory write APIs.

## Supported first phase

- Report import, per-order results, exact order-line reconciliation, ordinary lines without customization, and a protected customization viewer.
- Amazon Custom ZIP download, malware scan, JSON/XML interpretation, Amazon-provided preview, buyer image preview and exact original download, text/options, version-specific operator review, retry and manual ZIP replacement.
- Each custom line belongs to an existing core order line. A report upload never creates a second order for the same account/platform/order identity. A new item in a later report can be added without resetting the existing order workflow or platform status.
- The viewer's **已核对** is an internal check of a particular attachment version. It does not approve a production proof, create a purchase order, or authorize shipment.

Intake supports the priced order report and the unpriced unshipped report identified by `quantity-shipped`, `quantity-to-ship` and `promise-date`. Both require order/item identity, purchase date, SKU, title and purchased quantity. The priced form requires both `currency` and `item-price`; a partly missing financial header set or invalid financial value remains an explicit rejection. The unpriced form keeps currency, item, shipping and tax amounts unknown. It never supplies zero or a marketplace-derived currency. Unknown values are shown explicitly in the report UI and the core order view.

Intake records `report_imported` as its source status, leaves unmapped values absent, and does not infer FBA or shipment eligibility. Extra source columns, including the unshipped report's promised date and shipping quantities, remain in the encrypted raw report; this adapter does not reinterpret them as ERP shipment/production events or a verified ship-by deadline. FBA replenishment/shipping plans and additional report families require separate adapters; they are not ordinary customer orders.

## Operator flow and limits

1. Upload a TXT file up to 5 MiB and 1,000 orders; select UTF-8 or GB18030 if needed. Parsing validates required columns, quoted TSV, dates, item identifiers, quantity and minor-unit amounts before creating a batch.

   Invalid imports display a fixed diagnostic and, where relevant, a physical source row or missing required columns. Only a strict shared error-code schema crosses the API/Web proxy boundary; arbitrary upstream messages, source values and private links are not exposed. Financial absence in an accepted unpriced report is not an attachment warning and does not downgrade an otherwise complete Custom ZIP to partial.
2. Before materializing orders, the API registers a durable identifier-only attachment job in Redis alongside retention. The Worker processes persisted line requests with at most two concurrent downloads per batch; closing the page does not cancel that work. The page polls safe line progress and reopens the current result. Successful lines are not downloaded again by a replayed task. Transient download/scanner failures receive at most three line attempts; unavailable links, rejected files and invalid archives remain explicit failures. Reopen the workspace and use **继续后台解析** to register a new recovery dispatch, or retry/upload one line explicitly. An unavailable queue rejects intake before report bytes or orders are materialized.
3. Open an order line to compare the Amazon preview with buyer text, options and images. Display images are safe PNG derivatives. **下载原图** returns the unchanged uploaded source, and the displayed original dimensions are the source pixel dimensions.

   The Amazon snapshot can itself contain option illustrations rather than a final image composed with the buyer's upload (observed in the supplied pillow report). It is shown faithfully and is explicitly not a production print file. Empty image selections remain visible as **未提供图片** without inventing a required-field rule.
4. An unavailable URL, unsupported ZIP, failed malware scan or order mismatch remains a line-specific failure. Other lines continue. Supplement with the original Amazon ZIP up to 20 MiB; the order and item identifiers must match.
5. Review the current version after checking it. Re-importing the same source preserves this check. If a URL changes, stale media is hidden during processing; an identical ZIP checksum preserves the reviewed version. If automatic processing downloads different bytes, it stops with `attachment_changed` and preserves the current ZIP and its review. The operator must explicitly reacquire or upload a ZIP to accept a different immutable version and clear its check.

Parsed documents also carry `AMAZON_CUSTOM_PARSER_REVISION`. Reprocessing an older parser revision creates an immutable version even when the ZIP bytes are identical, so newly interpreted fields cannot silently inherit an old check. Font and color selections are displayed explicitly and inherited by text in the same customization container; remote font URLs are never downloaded.

ZIP parsing is bounded by file count, per-file and total expanded size, and image dimensions. JSON/XML/SVG and archive names are untrusted data: they are not executed. SVG is not rendered directly in the browser. Missing referenced previews are reported rather than substituted with a buyer image.

## API and authorization

All routes use authenticated membership, `withTenant()` and the non-owner database role. Reads that decrypt customization content additionally require `order:pii:read` and append protected-access evidence. Mutations require `order:write` and `order:pii:read`.

| Method | Route under `/v1/orders/reports` | Input / result |
| --- | --- | --- |
| GET | `/workspace` | Optional `accountId`, `batchId`; recent 30 batches and up to 1,000 line summaries |
| POST | `/import` | `accountId`, `marketplaceId`, `fileName`, decoded `content`; batch counts and per-order outcomes |
| POST | `/resume` | Optional `accountId`, `batchId`; explicitly requeue eligible pending/failed lines in the selected workspace; returns `queued` |
| GET | `/lines/:id` | Current line, surfaces, fields, file metadata, warnings and `versionId` |
| POST | `/lines/:id/process` | `expectedVersionId` (nullable); download and parse |
| POST | `/lines/:id/upload` | `fileName`, `contentBase64`, `expectedVersionId` (nullable); scan and parse supplied ZIP |
| POST | `/lines/:id/review` | Non-null `expectedVersionId`; record current-version review |
| GET | `/lines/:id/files/:key?versionId=…` | Authorized current-version bytes; safe PNG inline or original attachment |
| GET | `/lines/:id/files/:key?versionId=…&thumbnail=1` | Private PNG display thumbnail, longest side at most 320 px; only safe preview/buyer-image keys |

The Next.js `/api/orders/reports/*` proxy allowlists paths and query parameters, requires same-origin JSON mutations and bounds request streams. API identities stay server-side. Content and files use private/no-store responses; file responses also use `nosniff` and a sandbox CSP. File URLs include the current version to prevent an old screen silently reading new artwork.

## Persistence and retention

Migration `0091_order_unknown_money.sql` makes order totals, line prices and report amounts nullable as amount/currency pairs. Existing values and immutable sources are preserved. A later priced report may fill an unknown core line price only when its identity, SKU and quantity agree; an unpriced report cannot erase a known core line price or an otherwise complete existing order total. Adding a new line invalidates the previous aggregate until complete compatible report evidence establishes the new total. Current report amounts can remain unknown even when a prior source established core order money. See [order money evidence](../architecture/order-money-evidence.md). Refund amount verification and quote comparisons explicitly require their missing financial evidence instead of treating null as zero. Deploy API, Worker and Web together after the migration.

Migrations 0061–0063 add `amazon_order_report_batches`, `amazon_order_report_batch_items`, `amazon_order_report_lines` and `amazon_order_report_versions`, tenant-scoped foreign keys, forced RLS, version guards and preview metadata. Migration `0086_amazon_report_processing.sql` adds the non-PII `amazon_order_report_processing_requests` projection: pinned source/version, request/dispatch identifiers, attempt count and safe outcome code. Apply it before deploying the updated API and Worker. The shared `@yummyai/order-intake` package owns the same archive parser, gateway, version checks and encrypted storage path used by automatic processing and explicit HTTP recovery. Report text, source URLs, buyer customization, original ZIP and file bytes use the existing order-PII encryption vault. This bounded first implementation stores their encrypted envelopes in PostgreSQL; it does not create public or research assets. Larger volumes should move encrypted bodies to the private order storage domain without changing the line/version contract.

Initial jobs are registered before intake writes; explicit recovery jobs carry a dispatch identifier and wait for its transaction to commit. A Worker interruption can reclaim a stale two-minute line lease within the same three-attempt budget. Old source requests, completed requests, expired content and operator-superseded uploads are not re-executed. Queue payloads contain only batch/dispatch UUIDs; customer values, source URLs and bytes remain outside Redis and job logs. Parsing never reviews artwork, records customer approval or creates production work. Batch `completed` describes report materialization only; line `pending`, `partial` and `failed` states remain authoritative for attachment availability.

Recovery filters eligible lines before keyset pagination, independently of the 1,000-line display window. Every page dispatch commits atomically. Live leases and rows locked by another import/claim are left alone; an operator can run recovery again after that work ends. Archive mutations lock the report row before its processing request, and recovery uses `SKIP LOCKED` to avoid a multi-line lock cycle with report imports.

A background download whose ZIP checksum differs from an existing saved version stops with `attachment_changed`, including after a signed source URL rotates. The saved ZIP, immutable versions and review record are retained. The page asks the operator to inspect the source and explicitly use **重新获取附件** or **补传 ZIP** to select replacement bytes; a replacement creates a new unreviewed version. A matching ZIP can reuse the existing version and review.

Monitor the `amazon-order-report-processing` queue as well as retention. A stopped Worker leaves visible pending lines; restart Worker and allow existing durable jobs to continue. If a job exhausts queue retries, explicitly use **继续后台解析** after resolving the runtime problem. Missing attachment sources still require the original ZIP. Rollback can stop this processing queue without deleting report versions; deploy API, Worker and their shared package together. Existing legacy pending lines are adopted only through explicit recovery or a changed-source import, not an automatic scan of historical orders.

Migration `0084_order_report_read_models.sql` adds a derived read table keyed to the
immutable source version, with forced tenant RLS and the same order-PII vault.
Metadata and 320 px thumbnails have separate encrypted envelopes. Summary queries
select only metadata; list images use `thumbnail=1`; opening an image still reads
the original full display file. New imports create the derived row during parsing.
Existing versions populate it once on first authorized read, without changing their
document, archive, checksum, review status or version number. This initial read can
be slower while it builds thumbnails. No browser or public response cache is added.
Version pinning, PII permission, protected-access auditing and source expiry apply
equally to thumbnails. Retention clears both derived envelopes when their source
document is erased, including anonymization of the containing order. Read locks
serialize backfill with source erasure so a concurrent read cannot recreate erased
private data. Deploy this migration before the updated API/Worker.

Intake currently sets a maximum 30-day local report retention window, which re-importing or reprocessing an existing line does not extend. This is a local intake limit, not a claim that an arbitrary historical order meets Amazon's delivery-based retention requirements. Historical shipped orders require verified delivery dates and an appropriate earlier purge before production use. Existing non-report orders retain their own core PII policy; the report viewer cannot revive an expired report.

Each batch must enqueue an identifier-only `AmazonOrderReportRetention` job in Redis before order materialization. If scheduling fails, its report ciphertext is removed and no orders are imported. The Worker clears expired report/ZIP/parsed ciphertext without decrypting it. Every workspace/detail/mutation also invokes tenant-scoped expiry cleanup. A batch containing any already-erased or expired report order is rejected; failed per-order imports discard the complete batch source because it may contain an erased row. Batches containing expired orders lose their raw source even if that batch was imported more recently. Non-sensitive identifiers and counts remain for reconciliation.

Use the full local stack (`pnpm start:local`), including Redis, Worker and ClamAV. `pnpm dev:lite` alone cannot support this workflow. Existing `ORDER_PII_ENCRYPTION_KEY`, database, Redis and ClamAV configuration applies; there are no new secret variables. Monitor the dedicated retention queue for failed jobs and keep Worker available; a stopped Worker cannot execute scheduled cleanup.

The attachment-processing Worker also needs DNS and outbound HTTPS access to the
`zme-caps.amazon` country hosts allowed by `safeAmazonArchiveUrl`, including allowed
`*.amazonaws.com` redirects, and access to the private `CLAMAV_HOST:CLAMAV_PORT`.
Verify these connections from the Worker environment, not only from the API.
Keep the downloader's hostname, public-address, redirect, timeout and size checks
enabled; network configuration must not bypass them. Monitor the
`amazon-order-report-processing` queue as well as retention. Deployment order and
current isolated acceptance evidence are in the [daily operations runbook](order-daily-operations.md).

## Validation

Use the disposable runner for the unpriced-import integration and real browser cases:

```powershell
node --env-file=.env --import ./apps/api/node_modules/tsx/dist/loader.mjs tools/scripts/run-order-daily-acceptance.mts --suite=report-integration
node --env-file=.env --import ./apps/api/node_modules/tsx/dist/loader.mjs tools/scripts/run-order-daily-acceptance.mts amazon-report-unpriced.spec.ts
```

The new browser case uses the real authenticated import/proxy/parser/persistence path with synthetic unpriced TSV data. It verifies useful invalid-header errors, unknown-money rendering, reload, duplicate import and desktop/mobile widths. Its account and orders live only in the disposable database; the runner records and verifies full fixture database/bucket/Redis cleanup in `tmp/order-daily-e2e-<token>.json`.

The integration suite also verifies later authorized platform-sync recovery of
unknown money. Complete adapter evidence can fill an unknown total; partial,
conflicting or generic normalized inputs cannot establish that total. All known
core line prices remain protected.

### Unpriced report fix acceptance (2026-09-19)

- The supplied report passed a read-only parse: 36 rows and 36 orders, all with
  unknown financial fields. It was not imported into the business database.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` passed. The final
  provider-recovery change also passed API typecheck and targeted ESLint.
- The isolated report integration suite passed 69 tests across five files.
  The real unpriced browser import case passed, including helpful error text,
  persistence, duplicate import and 1440/390-pixel viewport checks.
- Every disposable test database, bucket and Redis instance was removed and
  verified by the runner. No synthetic order was added to the business database.
- Migration 0091 was applied locally; API, Web and Worker were available after
  verification, and the existing business order report list loaded normally.
  This is fix acceptance, not a release-candidate certification.

Parser tests use synthetic TSV/ZIP fixtures only. Database/service tests cover tenant isolation, core-order replay, missing/custom lines, content-version review, stale-file reads, archive mismatches, expiry and scheduling failure. UI unit/proxy tests and `pnpm test:e2e amazon-report-workspace` cover the browser workflow with an explicitly owned synthetic report API fixture. The E2E setup uses a real local authenticated account and disables that fixture account afterwards.

For an operator-authorized local report, `tools/scripts/check-amazon-report.mts` reads the supplied path and validates its live ZIPs in memory. It emits only counts and safe error codes; never put real reports, ZIPs, buyer data or download URLs into fixtures, screenshots committed to Git, logs or artifacts. Run the script from `apps/api` with Node's root `.env` and `tsx` loader.

Before running E2E in this worktree, stop its active Web and API processes; the suite owns ports 3100/8000 and the Next.js dev lock. Apply migrations and restore the ordinary runtime after testing. Rollback should disable intake and preserve encrypted evidence until retention cleanup; do not drop order tables or restore expired PII from backups.

### Local validation on 2026-09-08

- The operator-provided report was imported through the authenticated local API. The real Chrome page processed all 10 ZIPs and loaded all 10 thumbnails. Reprocessing with parser revision 2 produced 10 previews, 9 buyer images and 85 fields, with zero unknown field types and zero failed lines. One line retains a specific empty-image warning. A real tire-cover detail showed 12 fields, both images loaded, and no horizontal overflow. Real orders remain unreviewed for operator verification.
- `pnpm test`, `pnpm typecheck` and `pnpm build` passed. The final parser/service run passed 76 tests (31 TXT, 23 ZIP and 22 service integration); dedicated database tests passed 7, UI/proxy tests passed 16, and the report E2E passed at desktop and 390px. Changes after the full build were backend parser interpretation/version handling and explanatory viewer text, with affected typechecks/tests rerun.
- Full-repository lint is still blocked by pre-existing artifact-generator script errors; lint for changed implementation files passes. Full integration initially had timeouts; a lower-concurrency API rerun passed 360/361 cases and exposed a pre-existing supplier-performance fixture whose evidence cutoff is 2026-09-02 while new evidence uses the current date. Those unrelated source files were not changed. This is a module handoff, not a P0 release-candidate claim.
- The normal local API/Web/Worker runtime was restored after E2E. No marketplace authorization or publication was performed, and no real report/ZIP/buyer contents were committed to the repository.
