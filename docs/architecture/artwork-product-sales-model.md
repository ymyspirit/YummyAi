# Artwork, product and sales identities

Approved on 2026-09-13. The implementation preserves existing catalog, design,
listing, fulfillment and private-order history.

## Authoritative relationships

- An artwork master owns the print SKU and immutable approved creative revisions.
  Fixed artwork, variable text, customer-photo and mixed templates are distinct modes.
  Each version pins approved source materials and field-to-region placement.
  A customer plan can omit the fixed creative image while keeping its print identity,
  required buyer inputs, production instructions and reusable material manifest.
  Archive hides unused prints from new choices and is reversible; historical pins
  remain intact. Private customer originals never become reusable master artwork.
- An SPU owns reusable physical product specifications. Each specification version
  pins a process profile and optionally the controlled canvas print specification.
  The product page lists SPUs, with every size/color specification maintained inside
  its parent detail. Specifications are never separate product/SPU records.
  Multiple size, shape, color or custom values can be combined in a preview; only
  selected combinations become concrete specifications. Each has one value per
  dimension and an independently selected process/facts record. Batch writes are
  atomic and reject duplicate codes/combinations under a tenant/SPU lock.
  A physical SPU can be created here directly; it does not require a research-report
  approval. Existing sourcing relationships retain their catalog parent record.
- An artwork/SPU style owns sales SKUs, one for each selected specification.
  Creation is explicit and idempotent; changing artwork does not create another SPU.
- A sales recipe pins artwork and specification versions, its production editor
  source and approved production evidence. Revisions never alter old packages.
- A channel package pins a reviewed listing version and sales recipe. Explicit
  channel mappings preserve which package applied when an order was placed.
  A Listing may include multiple approved specification SKUs of the same style.
  Shared Listing mockups retain their source SKU/recipe/output/version/checksum;
  each SKU package requires an approved mockup from its exact production recipe.
- Order preparation stores a directly selected artwork/SPU specification basis or
  the resolved recipe and an order-only artwork override. Designers and the local
  template executor use the same pinned materials and private buyer requirements.
  Push and physical production release remain separate recorded actions.

## Existing data

The `print_profiles` domain remains a process-template identity. Its old codes are
not promoted into artwork SKUs. Old SKU/design/listing identities remain readable;
unmapped sales SKUs appear in a migration queue and need an explicit binding.
Formal SKU designs continue to own production adaptations; their SKU foreign key
is preserved. Independent artwork masters reuse approved creative versions.

## Implementation

Migration `0071_artwork_product_sales` introduces tenant-scoped artwork, specification,
style, sales-recipe, package, mapping and event records. Immutable versions and forced
RLS apply to the application role. Optimistic versions and per-tenant idempotency keys
prevent duplicate identities or silently overwritten decisions.

The existing SKU-specific design service owns approved production artifacts. The
Listing service owns channel drafts; legacy SPU/channel uniqueness remains for rows
without a style. Approved catalog editor projects are locked against edits/deletion.
New artwork or specification revisions mark affected recipes as needing a new version;
they never rewrite an order, Listing or sealed package.

Read [integration and permissions](../integration/product-development.md) and the
[user guide](../user-guide.md) for the working routes. No new secrets or environment
variables are required. Production adaptation currently uses the existing tire-cover
and shaped-pillow editor. Controlled mockup templates and their configured renderer
remain prerequisites for real suite rendering.

## Acceptance evidence

- `product-development.integration.test.ts`: one artwork, two SPUs, two specifications
  each and four SKUs; idempotency, tenant isolation, immutable versions, private editor
  copies, production review locks, multi-spec Listing mockup provenance, package byte
  checks and effective-dated order matching with order-only artwork overrides.
- `product-development.spec.ts`: ordinary APIs and rendered desktop/mobile pages for
  artwork registration, parent SPU grouping, child specs, combination, filtering,
  production editor handoff, return and reload. Physical SPUs are created through
  the ordinary UI/API, without an external AI provider or simulated research approval.
- `order-centers.spec.ts`: edited private requirements, explicit push, production
  render, partial production, QC, shipping, after-sales and saved filters.
- Mockup/Listing integration fixtures provide already-reviewed synthetic outputs.
  They do not establish real supplier specifications, physical samples or approval
  of an actual commercial PSD template.

External publication uses existing authorized marketplace APIs. No browser-based
seller-console automation, supplier contact or financial execution is added.
