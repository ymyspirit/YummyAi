# Amazon order report intake

The manual intake workspace is `/orders/import`, linked from **订单履约 → 导入亚马逊报告**. An operator selects an existing Amazon account and marketplace, then uploads Seller Central's tab-delimited TXT report. An account awaiting marketplace authorization can be used for manual intake; disabled or revoked accounts cannot. This path does not call marketplace order, publication, shipment, or inventory write APIs.

## Supported first phase

- Report import, per-order results, exact order-line reconciliation, ordinary lines without customization, and a protected customization viewer.
- Amazon Custom ZIP download, malware scan, JSON/XML interpretation, Amazon-provided preview, buyer image preview and exact original download, text/options, version-specific operator review, retry and manual ZIP replacement.
- Each custom line belongs to an existing core order line. A report upload never creates a second order for the same account/platform/order identity. A new item in a later report can be added without resetting the existing order workflow or platform status.
- The viewer's **已核对** is an internal check of a particular attachment version. It does not approve a production proof, create a purchase order, or authorize shipment.

The supplied report format lacks a reliable fulfillment channel, platform status and ship-by timestamp. Intake records `report_imported` as its source status, leaves unavailable values absent, and does not infer FBA or shipment eligibility. FBA replenishment/shipping plans and additional report families require separate adapters; they are not ordinary customer orders. This implementation does not claim to cover all Amazon report types.

## Operator flow and limits

1. Upload a TXT file up to 5 MiB and 1,000 orders; select UTF-8 or GB18030 if needed. Parsing validates required columns, quoted TSV, dates, item identifiers, quantity and minor-unit amounts before creating a batch.
2. The page imports order lines and starts an attachment queue with at most two concurrent requests. The queue is driven by the open browser page; closing the page can leave pending lines. Reopen the workspace and use **继续解析** or a line's retry action to continue. Report/line persistence and retention jobs do not depend on the page staying open.
3. Open an order line to compare the Amazon preview with buyer text, options and images. Display images are safe PNG derivatives. **下载原图** returns the unchanged uploaded source, and the displayed original dimensions are the source pixel dimensions.

   The Amazon snapshot can itself contain option illustrations rather than a final image composed with the buyer's upload (observed in the supplied pillow report). It is shown faithfully and is explicitly not a production print file. Empty image selections remain visible as **未提供图片** without inventing a required-field rule.
4. An unavailable URL, unsupported ZIP, failed malware scan or order mismatch remains a line-specific failure. Other lines continue. Supplement with the original Amazon ZIP up to 20 MiB; the order and item identifiers must match.
5. Review the current version after checking it. Re-importing the same source preserves this check. If a URL changes, stale media is hidden during processing; an identical ZIP checksum preserves the reviewed version, while different bytes create a new immutable version and clear its check.

Parsed documents also carry `AMAZON_CUSTOM_PARSER_REVISION`. Reprocessing an older parser revision creates an immutable version even when the ZIP bytes are identical, so newly interpreted fields cannot silently inherit an old check. Font and color selections are displayed explicitly and inherited by text in the same customization container; remote font URLs are never downloaded.

ZIP parsing is bounded by file count, per-file and total expanded size, and image dimensions. JSON/XML/SVG and archive names are untrusted data: they are not executed. SVG is not rendered directly in the browser. Missing referenced previews are reported rather than substituted with a buyer image.

## API and authorization

All routes use authenticated membership, `withTenant()` and the non-owner database role. Reads that decrypt customization content additionally require `order:pii:read` and append protected-access evidence. Mutations require `order:write` and `order:pii:read`.

| Method | Route under `/v1/orders/reports` | Input / result |
| --- | --- | --- |
| GET | `/workspace` | Optional `accountId`, `batchId`; recent 30 batches and up to 1,000 line summaries |
| POST | `/import` | `accountId`, `marketplaceId`, `fileName`, decoded `content`; batch counts and per-order outcomes |
| GET | `/lines/:id` | Current line, surfaces, fields, file metadata, warnings and `versionId` |
| POST | `/lines/:id/process` | `expectedVersionId` (nullable); download and parse |
| POST | `/lines/:id/upload` | `fileName`, `contentBase64`, `expectedVersionId` (nullable); scan and parse supplied ZIP |
| POST | `/lines/:id/review` | Non-null `expectedVersionId`; record current-version review |
| GET | `/lines/:id/files/:key?versionId=…` | Authorized current-version bytes; safe PNG inline or original attachment |

The Next.js `/api/orders/reports/*` proxy allowlists paths and query parameters, requires same-origin JSON mutations and bounds request streams. API identities stay server-side. Content and files use private/no-store responses; file responses also use `nosniff` and a sandbox CSP. File URLs include the current version to prevent an old screen silently reading new artwork.

## Persistence and retention

Migrations 0061–0063 add `amazon_order_report_batches`, `amazon_order_report_batch_items`, `amazon_order_report_lines` and `amazon_order_report_versions`, tenant-scoped foreign keys, forced RLS, version guards and preview metadata. Report text, source URLs, buyer customization, original ZIP and file bytes use the existing order-PII encryption vault. This bounded first implementation stores their encrypted envelopes in PostgreSQL; it does not create public or research assets. Larger volumes should move encrypted bodies to the private order storage domain without changing the line/version contract.

Intake currently sets a maximum 30-day local report retention window, which re-importing or reprocessing an existing line does not extend. This is a local intake limit, not a claim that an arbitrary historical order meets Amazon's delivery-based retention requirements. Historical shipped orders require verified delivery dates and an appropriate earlier purge before production use. Existing non-report orders retain their own core PII policy; the report viewer cannot revive an expired report.

Each batch must enqueue an identifier-only `AmazonOrderReportRetention` job in Redis before order materialization. If scheduling fails, its report ciphertext is removed and no orders are imported. The Worker clears expired report/ZIP/parsed ciphertext without decrypting it. Every workspace/detail/mutation also invokes tenant-scoped expiry cleanup. A batch containing any already-erased or expired report order is rejected; failed per-order imports discard the complete batch source because it may contain an erased row. Batches containing expired orders lose their raw source even if that batch was imported more recently. Non-sensitive identifiers and counts remain for reconciliation.

Use the full local stack (`pnpm start:local`), including Redis, Worker and ClamAV. `pnpm dev:lite` alone cannot support this workflow. Existing `ORDER_PII_ENCRYPTION_KEY`, database, Redis and ClamAV configuration applies; there are no new secret variables. Monitor the dedicated retention queue for failed jobs and keep Worker available; a stopped Worker cannot execute scheduled cleanup.

## Validation

Parser tests use synthetic TSV/ZIP fixtures only. Database/service tests cover tenant isolation, core-order replay, missing/custom lines, content-version review, stale-file reads, archive mismatches, expiry and scheduling failure. UI unit/proxy tests and `pnpm test:e2e amazon-report-workspace` cover the browser workflow with an explicitly owned synthetic report API fixture. The E2E setup uses a real local authenticated account and disables that fixture account afterwards.

For an operator-authorized local report, `tools/scripts/check-amazon-report.mts` reads the supplied path and validates its live ZIPs in memory. It emits only counts and safe error codes; never put real reports, ZIPs, buyer data or download URLs into fixtures, screenshots committed to Git, logs or artifacts. Run the script from `apps/api` with Node's root `.env` and `tsx` loader.

Before running E2E in this worktree, stop its active Web and API processes; the suite owns ports 3100/8000 and the Next.js dev lock. Apply migrations and restore the ordinary runtime after testing. Rollback should disable intake and preserve encrypted evidence until retention cleanup; do not drop order tables or restore expired PII from backups.

### Local validation on 2026-09-08

- The operator-provided report was imported through the authenticated local API. The real Chrome page processed all 10 ZIPs and loaded all 10 thumbnails. Reprocessing with parser revision 2 produced 10 previews, 9 buyer images and 85 fields, with zero unknown field types and zero failed lines. One line retains a specific empty-image warning. A real tire-cover detail showed 12 fields, both images loaded, and no horizontal overflow. Real orders remain unreviewed for operator verification.
- `pnpm test`, `pnpm typecheck` and `pnpm build` passed. The final parser/service run passed 76 tests (31 TXT, 23 ZIP and 22 service integration); dedicated database tests passed 7, UI/proxy tests passed 16, and the report E2E passed at desktop and 390px. Changes after the full build were backend parser interpretation/version handling and explanatory viewer text, with affected typechecks/tests rerun.
- Full-repository lint is still blocked by pre-existing artifact-generator script errors; lint for changed implementation files passes. Full integration initially had timeouts; a lower-concurrency API rerun passed 360/361 cases and exposed a pre-existing supplier-performance fixture whose evidence cutoff is 2026-09-02 while new evidence uses the current date. Those unrelated source files were not changed. This is a module handoff, not a P0 release-candidate claim.
- The normal local API/Web/Worker runtime was restored after E2E. No marketplace authorization or publication was performed, and no real report/ZIP/buyer contents were committed to the repository.
