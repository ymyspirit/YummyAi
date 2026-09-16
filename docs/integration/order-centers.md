# Order centers

The fulfillment workflow has five primary destinations: orders, artwork, production,
shipments and after-sales. Reusable artwork masters and process profiles belong to
the creative/catalog domains. Existing orders/order lines remain the
source identities. Order preparation is an editable, encrypted operational overlay
with immutable revisions; original reports and buyer assets remain evidence.

Importing never creates an artwork task. Saving a reviewed preparation and explicitly
pushing it creates the task. Operations may directly bind an artwork version and
an SPU specification version; the specification supplies its process version.
An existing sales recipe/channel match can prefill this basis. Each order line pins
its own basis, selected buyer images and private text. Separate artwork approval and
optional customer proof still apply.
Physical production requires a second explicit release of a completed production
render. Factory acknowledgements and shipment tracking are recorded as evidence;
internal writes do not contact factories, purchase shipping, or publish to stores.
See [product development](product-development.md) for effective-dated channel matching
and the compatibility boundary for existing process-only preparation.

Order, preparation, artwork, proof, production, shipment and after-sales states are
queried independently. Filters and pagination operate in the tenant database;
navigation preserves the query and selected order line. Draft changes after push
require recall or a documented change request. Released production versions remain
pinned. Retries preserve the original request key and reject changed payloads.

The orders list groups matching products by order, with independently selectable
product rows showing the production basis, customization summary, authorized image
previews, status and deadline. Grouped pagination counts orders and does not split
their matching lines across pages. A filter can still hide nonmatching sibling
products; group headings explicitly count the products in the current filter.
The first request contains workflow rows; `POST summaries` then reads only the
current page's private customization metadata. History and the full catalog load
when a product is expanded. Report reads share retention cleanup and a tenant
transaction. All image URLs use existing authenticated private preview routes.

The expand button mounts the existing editor directly below its product row.
Common edits do not navigate away. Selection survives page changes, and switching
filters clears it. A saved product that leaves the filter remains visible while
its inline editor is open. Navigation and editor switching guard unsaved changes.

Item, order-group and page selection are independent of preparation status.
Selecting all filtered results is explicit and bounded to 100 products per batch;
larger results require a narrower filter. Bulk binding and design scheduling offer
an enabled-by-default fill-empty-only mode. Previews call the same source, catalog,
required customization and image validations as individual saves. Buyer fields,
images and instructions are preserved. Binding/scheduling changes create a new
pending-review revision. Confirm review and push remain separate actions.
Execution uses the ordinary per-product draft/action endpoints with the preview's
revision, projection version, source version and idempotency key. Partial success
removes successful selections and preserves blocked/failed products for retry.
Batch AI review uses the configured model, displays a maximum batch cost, submits
one product at a time, and leaves suggestions for individual operator adoption.
Stopping a batch stops later submissions; an accepted AI task continues in the worker.

The details and continuous-review buttons also open the existing modal side panel. The list
remains mounted and its data query excludes `line`/`editor`; switching detail
does not reset filters, selection or list scroll. Continuous review snapshots
the current page's order-line IDs when opened, so saving a line out of a status
filter cannot shift or skip the next queued line. Previous/next and closing guard
unsaved changes and in-flight writes. Save-and-next uses the ordinary versioned
draft endpoint and advances only after success; it never dispatches design.
The final entry returns to the list, where the operator can start the next page
or refreshed filtered batch. Other centers retain their existing task lists and continuous processing.

The drawer's journey buttons switch review, artwork, production, shipment and
after-sales content in place through `detailMode`, from any of the five centers.
They preserve the original center's filters and frozen queue. Switching is guarded
by the same dirty/busy state as previous/next. These UI switches perform reads only;
status transitions still require the corresponding explicit business operation.

Artwork mode opens with the current composed production sheet inline, including
the order drawer reached through `/orders?detailMode=artwork` and `/order-artwork`.
Only completed PNG/JPEG/WebP sheet renders from the exact current editor version
are eligible; historical renders, image edits and enhancement outputs are never
used as a fallback. Loading, unavailable and failed images are explicit. If this
version has no viewable sheet, the operator can generate a full-resolution PNG
preview here using its saved background, without opening the production editor.
The preview remains a draft and does not authorize production. Existing jobs
continue to poll and display their result when complete.

The sheet supports fit-to-window and original-pixel inspection. Its adjacent
controls submit artwork, approve it, or reject it with a required reason, according
to the current workflow stage. Approval/submission remain disabled until the
current image loads and its file checks pass; backend preflight is authoritative.
Entering a rejection reason disables approval until that reason is cleared.
Failed submissions preserve the reason, and optional advance-to-next occurs only
after success. AI analysis tools load on expansion; file history stays collapsed.

`submit_artwork`, `approve_artwork` and `reject_artwork` require the displayed
`expectedEditorVersionId`. Rejection checks that version inside the same locked
tenant transaction as the order transition, clears the editor's current approval,
and records the encrypted reason in order history and the version ID in audit.
Historical versions and prior audit records remain immutable. A rejected file
cannot be released to production even if an older production render exists.

All new records use authenticated tenant transactions, forced RLS and private order
storage. Free-form customization, image names and event reasons are encrypted with
an expiring work-item data key. Shared print profiles accept only non-order source
projects. Expired work-item keys are erased by the existing retention job.

## Order workbench queries and archival

The `/orders` workbench uses compact queue totals, a common filter row, an
expandable advanced filter panel, and per-line next actions. Order review and
artwork review open the existing detail panel in the appropriate mode through
`detailMode`, without leaving the filtered list. This parameter is UI navigation
only and is excluded from the workspace data query and saved views. Saved views
remain browser-local and scoped by the authenticated account/tenant.

`GET workspace` and `GET selection` share the same tenant query:

- `stage`: exclusive preparation/artwork/production/shipment queue stage; it is a
  read projection, not an additional mutable workflow status. Cancellation and
  fulfillment evidence take precedence over preparation and artwork.
- `sku`, `printSku`, `spu`, `specification`: escaped case-insensitive substring
  filters; `designExecutor` uses the persisted effective human/Agent assignment.
- `orderNumbers`: up to 100 exact order numbers, separated by whitespace, English
  or Chinese commas, or semicolons. No array is interpolated into raw SQL.
- `labelStatus`: `not_due`, `unplanned`, `missing`, `partial`, or `ready`. Counts
  consider packages in current non-cancelled shipment versions. A package has a
  label when its label asset or nonblank external label identifier is recorded.
  The `missing` filter includes partial coverage; a new order with no packages is
  not automatically missing a label. Ready unallocated quantity is `unplanned`.
- `dateField`: `placed`, `imported`, `due`, or `dispatched` (most recent recorded
  dispatch event). `from`/`to` are inclusive local dates in validated IANA
  `timeZone`; SQL uses a half-open range ending at the next local midnight.
  Missing dates do not match. Dispatch means recorded physical handover, not
  file download, printing, warehouse outbound, or marketplace writeback.
- `archived`: `active` (default) or `only`.

The response adds `counts` with line/order/quantity totals, all queue stages and
independent held/overdue/source-changed/missing-label counts. Counts cover the
entire filtered result, excluding only `stage`, irrespective of pagination.
Attention counts can overlap and must not be added to the exclusive queue total.
Rows and totals are read in one repeatable-read transaction. Loading or failures
show unavailable counts; private summary failures never imply a missing SPU or a
default Agent assignment.

Migration `0083_order_workbench.sql` adds reversible `archived_at` and non-PII
search metadata (`search_revision`, specification version, executor) to existing
work items. The service refreshes legacy metadata through `withTenant` from the
current encrypted revision and updates it on save. Unreadable metadata stays
unknown; it never fabricates a binding. There are no new external connectors,
credentials, or public object-storage routes.

`POST lines/:id/archive` requires OrderWrite and OrderPiiRead with
`{archived, expectedProjectionVersion, reason, idempotencyKey}`. It serializes on
the existing work-item lock, checks optimistic concurrency, records an encrypted
immutable event, and sets a pause when archiving. Archived items leave all five
normal work queues, selection, search and counts. Restore preserves that pause
until an operator checks the record and resumes it. Existing source reports,
requirements, artwork and fulfillment evidence remain available as history; this
action never cancels a marketplace order or physically deletes immutable files.

The artwork panel displays recorded model/render jobs with their source version,
status and time. Only preflight attached to the current file version is displayed
as that version's last check; historical checks cannot approve a new draft. This
UI does not start paid model calls, retry failed jobs, or imply that unsupported
free-form pillow geometry is fully autonomous.

## API and ownership

The authenticated `/v1/order-centers` facade composes existing production, shipment,
supplier, and after-sales services. It does not write their tables directly.
The browser's same-origin `/api/order-centers/[...path]` proxy allowlists operations,
bounds JSON/upload sizes, and disables caching. No new credentials are required.

| Endpoint suffix                                                                                   | Operation                                                                                                                                               |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace`, `options`, `profiles`                                                                | Tenant-filtered queues and working choices                                                                                                              |
| `POST selection`                                                                                  | Full filtered selection, maximum 100 products, no implicit first-page selection                                                                         |
| `POST summaries`                                                                                  | Up to 100 authorized current-product summaries, without history or full catalogs                                                                        |
| `POST bulk/preview`                                                                               | Read-only proposed changes and per-product blockers; requires order write and PII read permissions                                                      |
| `lines/:id`, `lines/:id/revisions/:revisionId`                                                    | Current details and immutable private requirements                                                                                                      |
| `lines/:id/draft`, `lines/:id/actions`                                                            | Versioned operator edits and explicit handoffs                                                                                                          |
| `lines/:id/images`, `lines/:id/images/:imageId`, `lines/:id/report-images/:index`                 | Scanned original uploads and authorized previews                                                                                                        |
| `lines/:id/artwork-materials/:assetId`                                                            | OrderRead, OrderPiiRead and AssetRead; download only a file in the line's pinned artwork manifest, with current rights/version and SHA-256 verification |
| `lines/:id/operations`, `lines/:id/release`                                                       | Existing fulfillment records and production release                                                                                                     |
| `lines/:id/archive`                                                                               | Reversible internal archival/restoration; preserves evidence and pauses work                                                                            |
| `production/:id/milestones`, `production/:id/inspections`, `quality-standards`, `recoveries`      | Evidence-backed factory progress and QC                                                                                                                 |
| `lines/:id/shipments`, `shipments/:id/review`, `shipments/:id/dispatch`, `shipments/:id/tracking` | Package review, physical handover, and tracking                                                                                                         |
| `lines/:id/cases`, `cases/:id/contacts`, `cases/:id/decisions`, `cases/:id/complete`              | Private case records, decisions, and execution receipts                                                                                                 |

Migration `0070_order_centers.sql` adds the work overlay, encrypted immutable
requirements/events/assets, and print profile versions. Existing editor projects
and production versions pin work/source/render identities through tenant-scoped
foreign keys. Unique indexes precede dependent foreign keys in the migration.
Original imported order identity, report versions, and platform status remain intact.

Production quantities count current non-cancelled work and exclude superseded
recovery parents. Shipment approval and actual handover recheck completed,
QC-passed quantities; a partial shipment never changes the whole order to shipped.
After-sales details require order PII permission and do not expose private text in
the shared ordinary API. Closing a case records an execution receipt; the action
does not perform the refund, send customer messages, or purchase a replacement.

The current forms create one package for the selected order line at a time; the
existing shipment service still supports multi-line and multi-package requests.
Platform writeback is shown separately and remains with the authorized P1 flow.
The print editor currently supports the existing tire-cover and shaped-pillow
product specifications. No unimplemented product geometry is offered.

## Designer and template executor

`draft.designExecutor` defaults to `agent`; an explicitly selected `human` remains
supported. Both use the same
immutable preparation revision. Human work stays queued until explicitly claimed;
Agent dispatch requires DesignWrite and starts the bounded local template executor.
It copies the print master plus reusable raster/font assets into the private order
editor and places each mapped text/image field in the artwork's percentage region.
PSD/source files remain downloadable materials; this path does not parse Photoshop
layers or infer unsupported free-form layout rules. Photo enhancement runs as a
separate model-backed step for both executors.

Every selected buyer image is enhanced, regardless of the marketplace's image
beautification option being selected, declined, absent or blank. The original
option and original image bytes remain unchanged. `faithful_enhancement_v1`
improves clarity, exposure, white balance, color and noise while preserving the
subject's identity, features, pose, proportions and existing text. Background
removal remains a separate selected-model operation; it consumes the enhanced
image without changing the artwork again. There is no local segmentation fallback.

New private work projects queue one encrypted `order_image_enhancement` batch via
the existing production-editor queue. The worker uses the member's configured
default image route (or the sole usable image route if no default is selected),
checks pinned source checksums, and scans model results. All results are published
atomically as private assets plus one new unreviewed draft. Originals and prior
versions are immutable. Failed/interrupted paid requests are never resubmitted
automatically; a deliberate retry uses a new request ID. Paused, recalled, expired
or changed work cannot receive a late result. Production preflight blocks pending
or failed enhancement and use of an unenhanced selected original.

`POST /v1/production-editor/projects/:id/enhance-order-images` retries a private
order's selected original-image batch with `expectedVersionId` and `requestId`.
The authenticated same-origin BFF allowlists this route. The UI shows batch status,
refreshes the new version after completion and exposes an explicit retry after
failure. A missing/disabled default model is an error, not a silent bypass.
Existing explicitly assigned tasks and immutable revisions are not rewritten;
recall and re-push applies the new default workflow to an existing order.

The executor supports single-line text and one image per area, fits images without
stretching, and rejects unmapped inputs, ambiguous usage, missing required fields,
custom fonts/colors, conditional rules and other unsupported fields. It produces an
`in_progress` draft with visual review false, never a production approval. Template
instructions remain visible to the reviewer. Failed preparation returns to `queued`
with an encrypted `artwork_failed` event. Retry or recall to select a human designer.
Changing masters/specs never moves existing orders to their new versions.

The masterless `customer_image` shaped-pillow recipe is also recognized when its
materials are references only, it has no percentage layout, and it explicitly
defines `buyer_photo` (image), `crop_scope` (short text), and
`print_sides` (single choice). Its single selected original must use `buyer_photo`.
Only `head` / `Only Face` / `仅头部` and `body` / `Whole Body` / `全身`, with
`single_sided` or `double_sided`, are accepted. These are manufacturing parameters;
they never create text layers. Nonempty customer notes, unknown fields, conditional
rules and ambiguous mappings still require review. Preparation places an uncut
image at the pinned specification size and queues faithful enhancement. The model
cutout, independent contour optimization and proof render remain explicit follow-up
operations; dispatch alone does not mean a production sheet has been completed.

## Validation

- `order-workspace.integration.test.ts` exercises real RLS and migrations, immutable
  revisions, changed report sources, original-image copying, approval and quantity
  gates, private after-sales completion, and retention erasure.
- `order-centers.spec.ts` runs the ordinary authenticated UI and rendering worker
  against synthetic orders; it covers both handoffs, partial production/shipment,
  after-sales evidence, and six mobile page layouts.
- `order-review.spec.ts` owns synthetic in-memory order transport on the real
  `/orders` route; it checks list preservation, stable review order, save failure
  and retry, dirty/busy guards, direct links and mobile panel controls.
- The existing report importer and navigation acceptance suites cover the updated
  entry points, source ZIP recovery, editor reopening, and stable navigation.

Verified on 2026-09-13: 124 relevant unit tests, 52 integration tests, and 24
browser acceptance tests passed, along with the full workspace typecheck, build,
and project-rule checks. Scoped lint passed. Full workspace lint still reports
the pre-existing `console` / `no-undef` error in
`docs/project-map/scripts/generate-inventory.mjs:137`. The local page was also
checked in the browser with the dark theme and a 390-pixel mobile viewport.
