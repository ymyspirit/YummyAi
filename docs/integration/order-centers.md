# Order centers

Current per-permission scope, private-file I/O, command replay and parent follow-up
authority are specified in [order authority](order-authority.md). Operational
assignment does not establish personal/team ownership of an order.

## Whole-order daily workflow (2026-10-07)

Production, shipment and after-sales workspaces request `grouping=orders`.
Pagination selects matched orders, then returns every tenant-visible sibling in
those centers; a line filter cannot hide another pillow from the order row.
The collapsed row shows one lifecycle status, summed quantity and a concrete
next task. Expansion lists individual requirements; review navigation advances
once per order. Orders retain their matched-item inline editing behavior.

`GET /v1/order-centers/lines/:id/operations` isolates production, shipment and
after-sales failures in `readErrors`. A failed read is distinct from an empty
history and disables dependent writes until retry succeeds. The whole-detail
composition preserves its existing nullable sections. HTTP 5xx reads use outage
wording rather than input-validation wording. Migration 0099 is the additive
repair for older production tables lacking `request_checksum`.

Whole-order factory eligibility remains enforced by the pinned template,
manufacturing rules and verified capability. An ineligible factory explains its
supplier, activation, product, dimensions, sides, process or validity blockers
and links to its own configuration. Full delivery packages select every initial
production record by default and name missing items; per-file immutable receipts
and exception/remake history remain available within the order.

Quality-standard maintenance lives at `/settings/fulfillment` and uses the
existing versioned service. Daily production selects a standard version.
After-sales lists default to unresolved orders; `caseScope=all` includes closed
history. An explicit status filter remains compatible with older links. Whole
details offer direct case registration and show open issues before closed ones.
Declining a requested remedy (`rejected`) remains open until the operator records
the actual completion evidence. Only `resolved` and `cancelled` are closed.
The six order lifecycle statuses and actual handover boundary remain unchanged.

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
Approving the current artwork also queues its formal export in the same tenant
transaction. Operators only compare customer requirements with the composed proof
and approve or reject it; they do not select export settings or open the production
editor. The server uses the product's export defaults (white JPG for shaped pillows).
Replaying approval does not create another file. The queued render is durable even
if immediate queue delivery fails or the browser closes. The worker recovers these
deterministic exports through the existing tenant UUID routing index and rechecks
current approval, source/version and production preflight before saving the result.
Image generation and paid model calls are excluded from this recovery.
The production center shows file preparation progress; design/production staff can
retry failures or prepare files for legacy approvals. A technical export failure
does not ask operations to review the unchanged artwork again.
For pillows pinned to the factory JPG standard, the production instruction draft
uses the reviewed document's actual dimensions and process values. Older template
prose remains in history but is not copied over corrected order specifications.
Physical production requires a second explicit release of a completed production
render. Factory acknowledgements and shipment tracking are recorded as evidence;
internal writes do not contact factories, purchase shipping, or publish to stores.
The production center's shaped-pillow delivery panel batches exact reviewed JPGs
for one factory, locks an immutable manifest, and binds manual factory receipts and
partial remakes to the delivered file and reviewed replacement version. See
[production delivery](production-delivery.md) for download revocation, private
retention, receipt sequencing and the factory acceptance boundary.
See [product development](product-development.md) for effective-dated channel matching
and the compatibility boundary for existing process-only preparation.

Preparation, artwork, proof, production, shipment and after-sales keep their existing
execution records. The UI presents one whole-order lifecycle. Filters and pagination operate in the tenant database;
navigation preserves the query and selected order line. Draft changes after push
require recall or a documented change request. Released production versions remain
pinned. Retries preserve the original request key and reject changed payloads.

Orders and the four fulfillment centers use one `orderStatus` filter and six
read-only order totals. The default UI reads all matching orders (`workView=all`);
it does not require choosing a role or execution-stage view. Legacy `workView`,
`stage` and individual execution filters remain compatible query inputs. The UI
identifies active legacy conditions and clears them when a new filter is submitted
or the user explicitly clears them. Role labels on next actions are handoff
responsibilities, not named-user assignments.

The drawer starts with a whole-order overview, independently of the selected SKU,
search filter and page. `GET /v1/order-centers/lines/:id/order-detail` resolves the
source order through tenant RLS, then composes its full item list, pinned custom
requirements, current review versions/files, production history, shipments and
locally cached ShipOS observations through existing module services. A failed or
unauthorized section returns `data: null` and an explicit safe error; a successfully
read empty section returns an empty array. This read never synchronizes ShipOS,
submits to factories, buys a label or changes marketplace state.

The next action prioritizes blocked or unfinished sibling items before whole
production/shipping. It distinguishes file preparation, factory delivery,
acceptance, completion, quality inspection and actual parcel handover, and directs
the operator to the existing forms in the same panel. Per-item approval remains
explicit and version-bound. Saving keeps the order open; previous/next navigate
unique orders, while item buttons change the pillow within the order. Unsaved item
or receipt forms participate in the navigation guard and block conflicting edits.
The production editor returns to the same order when closed.
Overview refreshes do not replace the active item draft. External factory receipts
refresh both the full order and its operation forms, including sibling changes.
Whole-order next actions scroll to their matching form; platform confirmation
also opens its evidence form. The queue keeps its initial order identities even
when a saved item/order stops matching the underlying list filter.

Factory delivery history accepts `order` in its shared query contract. Normal
drawer delivery defaults to every initial item with complete ordered quantities,
one factory and one pinned factory version. Missing items or blocked files prevent
generation; explicit replacement delivery remains available separately. Immutable
delivery packages and per-file acceptance evidence remain unchanged. Local ShipOS
evidence includes its query time and existing-label download, and remains distinct
from a locally verified shipment and actual handover.

Migration `0099_production_request_checksum_compat` additively repairs databases
that applied the original `0094` before its nullable request-checksum field existed.
It is safe on fresh/current schemas and preserves production history. Apply the
normal migration command before starting the updated application.

Normal production and shipping commands operate on a complete order. The drawer
reads `GET /v1/order-centers/orders/:id/fulfillment`, independently of list filters,
and includes every order line, its fixed quantity, reviewed file and blockers.
One factory must have a current compatible capability for every item. The operator
chooses the factory and due date once; each production version still pins its own
formal render, manufacturing document, preparation revision and capability. Pillow
instructions use that reviewed document plus the item's pinned operator notes.

The four authenticated, tenant-scoped POST commands are
`orders/:id/release`, `orders/:id/production-progress`, `orders/:id/quality-pass`
and `orders/:id/shipments`. They require the complete unique line set, exact ordered
quantities and current work revisions/projections. Production progress and QC also
pin each production projection. Each command validates and commits in one tenant
transaction. Locks coordinate ordinary production, QC, recovery and shipment writes;
failed commands leave no partial records. UUID request keys and content digests
make retries replay the original result and reject changed content.

Whole-order quality-pass records an operator's completed inspection of every item
against the selected immutable standard. Scores below that standard and mismatched
supplier/SKU scopes are rejected. Item defects, remakes and historical partial work
remain available in the expandable product history. They are not automatically
marked as passed by the group action.

The ordinary shipping form builds exactly one package with all items and quantities.
It requires all production quantities to pass QC and blocks duplicate packages.
Whole-order package amendments, approval and actual dispatch recheck completeness,
source changes, approval/proof, pause/retention and QC. A draft or an approved package
does not change the lifecycle to shipped; actual handover evidence does. Existing
per-item APIs/records remain for compatibility and exception handling. These commands
do not submit to factories, create ShipOS orders, purchase labels or write to a store.
The projection binds design-run status to the current work revision. It distinguishes
operator review/customer proof/platform confirmation from design and production work;
approved artwork is displayed as waiting for formal files and production arrangement,
never as a production release. Existing labels do not imply physical handover.
The order list prioritizes expired platform deadlines, intervention, unknown Amazon ship-by
dates and upcoming platform dates. Internal due dates remain separate. A missing
platform date is explicit and never interpreted as no deadline risk. Orders and their
matching lines remain grouped; sorting and counts do not depend on the current page.
The compact list exposes one next-action control with role and deadline. Source assets,
production basis and customization remain available in expandable context and details.
Continuous operations snapshot both line IDs and their task destinations. Successful
review advances to the next task's content within the same drawer; failures retain the
current record, input and idempotency key. Technical tools, other stages and history
are secondary disclosures. Task presentation adds no write transition or external call.

## Whole-order lifecycle

Normal shaped-pillow fulfillment produces, packs and ships every item in one order
together. Item-specific images, specifications and approved files remain separate.
The lifecycle is computed from all tenant-visible order items before module, SKU,
search, status or pagination filters. It is not a writable status selector.

| `orderStatus` | UI label | Evidence required across the whole order |
| --- | --- | --- |
| `processing` | 处理中 | Intake, missing information, design or corrections still remain. |
| `awaiting_review` | 待审核 | Every artwork is submitted or approved; artwork approval or required current customer proof remains. |
| `reviewed` | 已审核 | Every artwork is approved and any required customer proof matches the approved current editor version. Formal export or factory arrangement may still remain. |
| `produced` | 已生产 | Each item's full ordered quantity is completed and passes the existing production quality gate. |
| `shipped` | 已出库 | Each item's full ordered quantity has recorded physical shipping evidence in an approved shipment version. |
| `voided` | 已作废 | The order is confirmed cancelled. |

Confirmed voiding takes precedence. Otherwise actual shipping and production
milestones take precedence over earlier review work. Pause and after-sales remain
visible flags and records. Labels, downloads, factory file acceptance and marketplace
acknowledgements never advance physical production or shipment. Unknown or stale
customer-proof versions cannot produce the reviewed state.

Rows and details expose `orderStatus`, `orderLineCount` and `orderQuantity`. A filtered
group displays both its matched items and the full-order quantity; one approved item
cannot make a three-item order reviewed. `counts.orderStatuses` counts distinct
orders in the selected module/store/search/product/date/archive scope, before the
selected lifecycle and legacy execution filters, independently of pagination.
The detail panel shows the lifecycle first and collapses execution-stage navigation
under “查看制作、生产和发货记录”. No previous stage is marked approved merely because
an old order has a later physical milestone. Legacy partial production/shipping and
remake history remains intact; it reaches a later lifecycle state only when all
ordered quantities have the required evidence.

The orders list groups matching products by order, with independently selectable
product rows showing the production basis, customization summary, authorized image
previews, status and deadline. Grouped pagination counts orders and does not split
their matching lines across pages. A filter can still hide nonmatching sibling
products; group headings explicitly count the products in the current filter.
The first request contains workflow rows; `POST summaries` then reads only the
current page's private customization metadata. History and the full catalog load
when a product is expanded. Report reads share retention cleanup and a tenant
transaction. All image URLs use existing authenticated private preview routes.

Saved work details also expose `sourceVersionId` and `sourceReport`. These refer
only to the source pinned by the current immutable work revision; `report`
continues to mean the latest platform report. Unsaved work has no pinned source.
Unavailable or erased source evidence returns `sourceReport: null`, never the
latest report as a substitute. Historical customization metadata and files are
versioned; order identity fields remain operational context, and historical
financial amounts are not inferred from today's report.

Pinned preview, buyer image and original attachment keys use
`GET /v1/order-centers/lines/:id/source-files/:key?revision=N` (same path beneath
the Web `/api/order-centers` proxy). `N` must equal the current saved work revision;
clients cannot select arbitrary report versions. Metadata and file reads enforce
OrderRead, OrderPiiRead, tenant RLS, version/line ownership and retention. Files
stay private with no-store, no-referrer, nosniff and sandbox headers; originals
download as attachments. Concurrent work changes cause a refresh conflict. An
editor bound to an older work revision must not display this current revision's
source as if it were that editor's evidence.
The Web image proxy additionally accepts an optional nonnegative `attempt`
integer for image retries; it strips this presentation-only parameter before
calling the API and rejects all other source-file query parameters.

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

The five fulfillment centers use compact whole-order totals, a common filter row, an
expandable advanced filter panel, and per-line next actions. Order review and
artwork review open the existing detail panel in the appropriate mode through
`detailMode`, without leaving the filtered list. This parameter is UI navigation
only and is excluded from the workspace data query and saved views. Saved views
remain browser-local and scoped by the authenticated account/tenant.

`GET workspace` and `GET selection` share the same tenant query:

- `orderStatus`: the six whole-order lifecycle values above, computed before item
  filtering and grouped pagination. The shared UI exposes this single state filter.
- `stage` (legacy API/link support): exclusive preparation/artwork/production/shipment queue stage; it is a
  read projection, not an additional mutable workflow status. Cancellation and
  fulfillment evidence take precedence over preparation and artwork.
- `sku`, `printSku`, `spu`, `specification`: escaped case-insensitive substring
  filters; `designExecutor` uses the persisted effective human/Agent assignment.
- `orderNumbers`: up to 100 exact order numbers, separated by whitespace, English
  or Chinese commas, or semicolons. No array is interpolated into raw SQL.
- `labelStatus` (legacy API/link support): `not_due`, `unplanned`, `missing`, `partial`, or `ready`. Counts
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

The response adds `counts.orderStatuses` as described above, plus existing
line/order/quantity totals, legacy queue stages, role views and
independent held/overdue/source-changed/missing-label counts. Counts cover the
entire filtered result, excluding `stage`, `workView` and `orderStatus`, irrespective of pagination.
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
| `deliveries`, `deliveries/:id`, `deliveries/:id/file`, `deliveries/:id/items/:itemId/feedback` | Immutable shaped-pillow ZIP handoff and manual file-bound factory feedback |
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
