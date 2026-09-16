# Product development

The authoritative identity chain is independent artwork SKU → artwork/SPU style →
sales SKU for one specification → immutable production recipe → reviewed channel
package. An SPU contains multiple specifications; its parent page is
`/product-specifications`, and `?spu=<id>` opens its child specifications.

## Routes and permissions

All API routes below use `/v1/product-development`. The browser uses the same-origin
allowlisted `/api/product-development/[...path]` proxy. UUIDs and JSON inputs are
validated by shared contracts. Reads disable caching; writes require authenticated
membership and additional domain permissions, never a caller-supplied tenant header.

| Method and suffix | Required permissions and behavior |
| --- | --- |
| `GET options`, `GET workspace`, `GET skus/:id` | ProductRead; tenant choices, paginated SKU search and version history. Store choices additionally require StoreRead. |
| `GET assets/:id/preview` | AssetRead; rights-approved authorized-domain raster preview, never buyer/research assets. |
| `POST artworks` | ProductWrite and DesignReview; independent print code with an approved creative master, or a customer plan with required input fields and production instructions. |
| `POST artworks/:id/archive` | ProductWrite; reversible archive/restore with `archived`, `expectedVersion`, `reason` and `idempotencyKey`. Historical versions and relationships remain intact. |
| `POST spus` | ProductWrite; create a reusable physical product directly, then add child specifications. Duplicate SPU codes conflict. |
| `POST spus/:id` | ProductWrite; edit code, name and description on the existing SPU and product-plan parent, using `expectedRevision` from `options`. Archived records, stale revisions and duplicate codes conflict. |
| `POST specifications` | ProductWrite; child of an existing SPU, versioned facts/attributes, approved generic process and optional controlled print spec/shared stock item. |
| `POST specifications/batch` | ProductWrite; `{ spuId, items, idempotencyKey }`, 1–50 new concrete specifications in one atomic transaction. Each item has the single-spec fields except `spuId`, `expectedVersion` and `idempotencyKey`. |
| `POST combinations` | ProductWrite; up to 50 specification/SKU combinations or explicit legacy SKU mappings, within one idempotent transaction. |
| `POST skus/:id/revisions` | ProductWrite; same style/specification identities, new pinned artwork/spec revisions. |
| `POST recipes/:id/actions` | ProductWrite plus editor/design/asset permissions for the action; start or approve production adaptation. |
| `POST listings` | ListingWrite; one style with multiple distinct approved specification SKUs. |
| `POST packages` | ListingReview and ProductWrite; seal the current approved Listing and exact approved production recipe. |
| `GET packages/:id/export` | ListingRead and AssetRead; private ZIP, manifest fingerprint plus current rights, asset version and SHA-256 byte verification. |
| `POST channels` | StoreManage and ProductWrite; explicit store/site/external SKU/Listing identity, evidence and effective-from timestamp. |

Every write accepts `idempotencyKey`. Retrying an identical request returns its
original result; reusing the key with different content conflicts. Master/spec/recipe
revisions also check the expected current version. No endpoint publishes a Listing.

SPU basic edits retain the SPU and product-plan IDs, customization, all SKU/specification
links, and historical recipes/packages. The audit event records previous and current
basic metadata. A matching profile-level SPU code follows a code rename; other product
facts require their existing explicit profile operation. `options.spus` includes the
description and an opaque revision. Legacy clients may ignore these extra fields.
The detail page provides “编辑 SPU”; a failed save keeps the entered values and uses
the original revision until the user reloads/reopens the form.

`options` excludes archived SPUs and SPUs whose product-plan parent is archived,
including their child specifications. Archive unused product plans through the
existing `POST /v1/products/plans/:id/transitions` endpoint with `status: archived`;
the SPU list and new-product selectors then stop offering them. Existing product,
SKU, specification and immutable recipe/package records remain available for history.

The product-development workspace also excludes an archived SKU, an archived SPU,
or a SKU whose product-plan parent is archived. This predicate applies before
search, status filtering, pagination and totals. Direct SKU details and immutable
recipe/package history remain readable, so archiving a test product removes its
children from the daily list without deleting historical records.

Specifications can be saved before a factory process is available. Migration
`0079_specification_drafts` makes `processProfileVersionId` nullable; null requires
`facts.factsConfirmed: false`. These drafts appear in the SPU workspace, but are not
offered as order-production choices and cannot create or revise sales recipes.
Supply an approved, authorized generic process and verified facts through a new
specification version to enable production. Existing specification/recipe versions
remain immutable. Product-page size labels do not establish cutting dimensions,
seam allowance, print DPI or factory tolerances.

The SPU form accepts multiple size, shape, color or custom option values, previews
their combinations, and saves only the selected combinations. The UI supports up to
four dimensions and 50 preview combinations per batch. Each saved specification has
one value per dimension, its own physical facts and process version; this is not a
multi-valued specification or automatic production adaptation. Common form values
can be overridden per row. Bound options are derived from current specification
versions, so refresh preserves them without a separate option dictionary.

Single and batch specification writes serialize on the same tenant/SPU lock.
Duplicate codes or attribute combinations conflict; attribute order does not create
a distinct combination. A failure rolls back the entire batch and its idempotency
event. Batch creation never replaces an existing specification; editing one uses the
single-spec version endpoint. Existing SKU recipes keep their pinned version.

## Ownership and persistence

Migration `0080_artwork_optional_master_archive` allows a customization plan to
have no fixed creative master or master asset. Fixed mode still requires both;
masterless plans require a buyer image/text field and nonempty instructions.
Reusable materials remain independently versioned, rights-approved assets. The
`reference` role is available to order operators but is not inserted into print layers.

`options.artworks` contains active records; `options.archivedArtworks` contains
recoverable archived records. Archived prints cannot receive new versions or new
SKU combinations. Existing recipes and pinned order materials remain readable;
restoring a print retains its identity and version. New order choices omit archived
prints while an existing order can retain its pinned choice.

A masterless order starts with private buyer images and pinned reusable materials;
the process template supplies geometry without copying its sample image/text layers.
Required buyer inputs and existing specification/review checks still apply. An
unmapped contour design requires human placement and review. Generic sales adaptation
needs a fixed master; customer-plan display samples need a separate reviewed source.

Migration `0082_customer_plan_readiness` adds `ready_for_customization` for sales
recipes with no fixed master and a required buyer-image field. The explicit
`confirm_customization_plan` action requires DesignReview, authorized materials,
verified product facts and a reviewed generic process. It pins the plan without
creating a sample production image. Orders can select that SKU and use its pinned
process with private customer images. The plan is immutable after confirmation;
changes create a new recipe. This status does not approve an order file or permit
sealing a listing package without reviewed display imagery.

Migration `0071_artwork_product_sales` creates `artwork_masters`,
`artwork_master_versions`, `product_specifications`, `product_specification_versions`,
`product_styles`, `sales_sku_definitions`, `sales_recipe_versions`,
`sales_package_versions`, `sales_channel_bindings` and `development_events`.
Foreign keys include tenant scope. All operations use `withTenant()` and forced RLS.
Masters advance a version counter; committed version/evidence rows stay immutable.

`ProductDevelopmentService` owns catalog identities and reads existing approved
creative masters. Creative asset versions remain pinned through the immutable
creative-version asset relation. `SalesAdaptationService` owns formal SKU-specific
design versions and their authorized production files; it composes the existing
private production editor. `ListingService.createDevelopmentDraft` owns Listing
writes inside the caller's tenant transaction. New styles use style/channel uniqueness;
legacy Listing records keep their original SPU/channel constraint.

Physical SPU creation also creates its required legacy `product_plans` parent in
`developing` state so sourcing and existing product links continue to work. That
compatibility record has no research reports or approval actor/time. It does not
bypass or change the existing research-plan approval endpoint.

Generic `print_profiles` remain process templates at `/process-library`. They cannot
reference an order or sales-recipe source project. Approved sales recipe projects
cannot be edited or deleted. Subsequent changes start a new recipe/project version.
Copied buyer/order assets retain private, expiring order keys and never enter masters.

## Package and order invariants

Each package contains product facts, artwork/specification and editor/design pins,
reviewed Listing content, per-image usage evidence, controlled mockup source pins,
private asset identifiers/versions/checksums, and review actor/time/reason. Every
declared mockup must be approved and belong to a listed SKU in the same style. At
least one must use the package's exact recipe. Other specification images can share
the Listing while keeping their own provenance. Amazon customized main images require
explicit finished-product-photo evidence. Download rejects changed bytes or rights.

Channel mappings are immutable and effective-dated. Imports resolve the store,
marketplace, seller SKU and available Listing identity at the order's placed-at time.
Missing or ambiguous mappings are shown explicitly. Saved order drafts always keep
their selected recipe/package and optional independent print override.

An order operator directly selects the artwork SKU version, product SPU and concrete
specification, or starts from a channel-matched sales recipe. The specification pins
product/process geometry. Private text/images belong to that order only. A human
designer receives the materials and requirements; the optional local template
executor places explicitly mapped text/images into configured regions and creates
an unreviewed draft. Import and save do not create a production task: explicit push
creates artwork work, and physical release remains a separate reviewed action.

Before the tenant registers its first independent artwork, legacy process-only order
preparation remains available. After registration, confirming new preparation requires
a valid artwork and SPU specification basis, directly or through an approved sales
recipe; pre-existing pushed/released history remains pinned. Existing
SKU mappings are explicit in the product-development migration queue.

## Local validation

Single-record work opens in a right-side modal drawer over the existing catalog
list. Print instructions/materials, SPU details, individual specification edits,
print registration and combinations share this behavior. Sales SKU details retain
the originating page's queue for previous/next processing. Form submits stay in a
fixed footer; errors keep inputs and submission retries preserve their key. Batch
specification binding and the production editor use full workspaces. See
[navigation behavior](../architecture/erp-navigation.md#record-drawers-2026-09-15).

Use the [local development runbook](../operations/local-development.md); migration
0071, 0072 and existing Postgres, Redis, private storage and the production Worker are
required. There are no new environment variables or credentials. Start the configured
controlled mockup renderer when testing real templates. The built-in production editor
currently supports tire covers and shaped pillows.

Run the catalog, order-workspace, production-editor and batch-promotion integration
suites, then `pnpm test:e2e product-development order-centers` with the dev servers
stopped. The browser suite exercises real catalog/order APIs and synthetic originals;
upstream approved mockup/Listing outputs are explicitly owned integration boundaries.

## Reusable material manifest

Migration `0072_artwork_materials` adds immutable `materials` and `layout` JSONB to
artwork versions and the `mixed` mode. Each manifest pins asset ID, version, SHA-256,
file name, MIME type, role and usage. Roles include the automatically selected approved
creative master, source PSD, background, decoration, font and reference notes.
All files must be rights-approved authorized assets in the same tenant; buyer and
competitor assets are rejected. Legacy versions without a manifest expose their
existing pinned creative master. Each layout region binds a customization field key
to bounded canvas percentages. Changes create another artwork version.

The web upload action uses existing authenticated asset upload and rights-review
APIs, then registration validates and pins the resulting assets. This upload is for
print source materials. Controlled product-mockup PSD inspection, slot binding and
renderer approval remain a separate workflow.
