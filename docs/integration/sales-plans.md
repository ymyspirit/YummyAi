# SPU-first sales plans

Daily catalog navigation is **商品库 → 上架工作台 → 刊登管理**. Create the physical
SPU first, then multiple sales plans for that SPU. A sales plan owns its audience,
research conclusion, copy, selected designs/SKUs/images, Custom option materials and
channel preparation. The five steps are carrier/process, print design, sales composition, imagery/copy,
and listing review. Research and positioning remain supporting evidence. Steps show missing information and allow partial
draft saves; they do not create an approval or production release.

The same saved plan also has an **上新任务** view. It projects six business stages,
pins assistant input, compares selected fields before adoption, and links to current
reviewed export packages. See [sales-plan-launch.md](sales-plan-launch.md) for routes,
permissions, version invalidation and isolated acceptance.

The two independent axes are `mode: custom | standard` and `fulfillment: fbm | fba`.
Amazon Custom accepts FBM only. Standard products can use FBM or FBA. Different
plans share SPU/specification facts, but have independent content and listings.
FBA procurement and channel inventory remain separate from customer-order production.

## Data and compatibility

Migration `0101_spu_sales_plans.sql` adds `spus.capabilities` (processes,
customization scope, packaging), `sales_plans`, and optional
`listings.sales_plan_id/sales_plan_revision`. Specification facts optionally record
product/packaged weight in grams and package dimensions; missing measurements remain
unknown. Old specification, artwork, recipe, listing, package and order pins survive.
No legacy sales mode is guessed and no historical listing is automatically reassigned.

Sales-plan identity and SPU are fixed. Revision-checked changes advance the revision;
idempotency is recorded in existing development events. The application role has
forced tenant RLS and no sales-plan delete grant. Plan archival removes it from active
lists without deleting linked listings or immutable history. Default catalog views
exclude archived records; explicit history filters remain available.

The legacy SPU/style channel uniqueness applies only to listings with no sales plan.
New listings are unique per tenant, sales plan, platform, marketplace and locale.
Sales SKU/style/recipe creation continues through existing product-development
services. Selected SKUs belong to one SPU. Native Custom pattern choices may group different
styles on the same physical platform SKU. See [sales compositions](sales-compositions.md).
Known print/recipe modes must also match the plan: standard products use fixed prints,
and Custom products use personalized text/customer-image/mixed templates. Legacy
unmapped SKU modes remain unknown rather than being inferred from their codes.
Reviewed package sealing keeps its original design and manufacturing gates.

## API and permissions

All routes use `/v1/sales-plans`. Reads require ProductRead; create/save/archive also
require ProductWrite. Listing draft creation requires ProductRead and ListingWrite.
Research, design, asset, listing and account references require their own domain
permissions and are resolved through `withTenant()`.

Create/save recheck those current source read scopes before returning a cached
idempotent result. Narrowing a source grant cannot reuse an earlier result as
authorization. Listing content writes/reviews use the Listing's own created_by,
independently of ProductRead; see [Listing authority](listing-authority.md).

| Route | Behavior |
| --- | --- |
| `GET options` | Active SPUs/specifications/SKUs and permission-scoped research, designs, approved authorized images, projects and Amazon accounts. |
| `GET /` | Query `q`, `spuId`, `archived=0|1`, `page`; 25 records per page. |
| `GET :id` | Plan and current linked listing versions; listing details require ListingRead. |
| `POST /` | `{ spuId, fields, idempotencyKey }`; supports incomplete drafts. |
| `POST :id` | `{ fields, expectedRevision, idempotencyKey }`; stale revisions conflict. Sales mode/fulfillment cannot change after a listing exists. |
| `POST :id/archive` | `{ expectedRevision, idempotencyKey }`; retains history. |
| `POST :id/draft` | `{ expectedRevision, expectedListingVersionId, idempotencyKey }`; creates a local draft or a new immutable draft version. |

Draft sync is limited to the latest unreviewed draft and requires its version ID.
Plan copy/media/SKUs replace their corresponding draft content; listing-editor
category attributes, compliance, A+ and personalization settings remain intact.
Changing an already configured product type requires an explicit listing revision.
All reviewed/exported versions retain their original content.

`POST /v1/listings/:id/archive` archives a local listing under ListingWrite. It does
not deactivate a marketplace offer. Linked publications/versions remain historical.
Do not use it as a marketplace unpublish operation.

The browser proxy `/api/sales-plans/[[...path]]` uses shared schemas, allowlisted
paths, bounded JSON bodies, same-origin writes and authenticated server API calls.
It uses the configured deployment API with the current personal server identity;
production requires the shared personal OIDC configuration and forbids developer
service-identity fallback. No caller-selected tenant is accepted. Read/write
timeouts, session coherence and exact cached draft receipts follow the
[workspace session contract](sales-plan-session.md).

Current unsaved reference IDs can be resolved through read-only
`POST :id/reference-options` (HTTP 200). It prioritizes selected authorized records
beyond the default candidate window and preserves accessible historical artwork
versions. Missing choices stay pinned until explicit replacement/removal; see
[reference resolution and repair](sales-plan-references.md).

## Handoffs and marketplace state

Helpers reuse product facts, research, content projects, canvas, print library,
SKU development, mockups, authorized assets, stores and listing review. `returnTo`
preserves the selected plan, step and filters. Same-tab temporary drafts pin their
original revision and current object/authorization scope. Background reads do not
reset edits; confirmed scope loss clears them. Save persists to the server; a hard
browser reload keeps saved content and clears unsaved temporary input. Target account/site are passed to
the listing editor and checked against its authorized choices before submission.

Creating a local listing does not call Amazon. Existing supported marketplace APIs,
store authorization, review/export and publication reconciliation remain responsible
for actual submission and saleability. Custom page configuration currently exports a
**configuration draft** (fields, layout, instructions and authorized material IDs),
then records manual configuration/verification evidence. It neither configures Seller
Central automatically nor replaces a reviewed immutable export package.

## Validation

Run the contract tests, `apps/api/src/catalog/sales-plan.integration.test.ts`, and
`pnpm exec playwright test --config apps/web/playwright.sales-plans.config.ts`.
Stop the workspace Next.js/API dev servers before the browser suite, then restore
with `pnpm start:local`. The suite uses real application paths, records exact
fixture IDs under ignored `tmp/sales-plans`, and archives them in `finally`;
immutable development events and listing versions remain as test history.
