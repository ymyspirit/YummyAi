# Catalog integration

The catalog boundary owns tenant-scoped product plans, customization schemas,
SPUs, and SKUs. Clients must use the authenticated REST API; they must not write
catalog tables directly.

## Product-plan customization

`PATCH /v1/products/plans/:id/customization` replaces the complete
customization schema of a researching product plan.

```json
{
  "customization": {
    "version": 1,
    "fields": [
      {
        "key": "photo_upload",
        "label": "Upload your photo",
        "required": true,
        "type": "image",
        "validation": {
          "allowedMediaTypes": ["image/png", "image/jpeg"],
          "maxFiles": 1,
          "maxBytes": 10000000
        }
      }
    ]
  }
}
```

The route requires `ProductWrite`, derives tenant context from the authenticated
membership, validates the complete shared contract, and updates through
`withTenant()`. Customization is locked after the plan leaves `researching`
because SPU creation copies the approved schema into catalog master data.

## Amazon Custom product package

`CustomProductPackageV1` is the reviewed handoff from YummyAI research and
catalog data to Amazon Studio. The product plan stores its editable
`custom_product_profile` JSONB value; the ZIP is generated on demand and is not
stored as mutable catalog state.

### REST workflow

| Method and route                                         | Purpose                                          | Required permission            |
| -------------------------------------------------------- | ------------------------------------------------ | ------------------------------ |
| `POST /v1/products/plans/:id/custom-package/provisional` | Build an editable profile from one research item | `ProductWrite`, `ResearchRead` |
| `PATCH /v1/products/plans/:id/custom-package/profile`    | Replace the validated editable profile           | `ProductWrite`                 |
| `GET /v1/products/plans/:id/custom-package/completeness` | Evaluate release readiness                       | `ProductRead`                  |
| `GET /v1/products/plans/:id/custom-package?mode=draft`   | Download a draft ZIP, including blockers         | `ProductRead`, `AssetRead`     |
| `GET /v1/products/plans/:id/custom-package?mode=release` | Download only when all release gates pass        | `ProductRead`, `AssetRead`     |

The provisional request contains a research item ID and target marketplace:

```json
{
  "researchItemId": "019fb6ba-fa80-7c6c-afb5-1c9594cc0d8c",
  "targetMarketplace": "amazon.com"
}
```

Values copied from competitor evidence use `source: competitor_reference` or
`source: inferred_from_research` and
`verificationStatus: unverified`. A seller edit remains unverified until the
user explicitly confirms the whole current fact form. The confirmation action
changes the source to `seller_provided`; it does not approve or promote an
asset.

Draft export is intentionally available while incomplete so Amazon Studio can
start a non-publishable project. Release export fails with `422` until the
profile has SKU, marketplace, product type, brand, material, size, package
quantity and contents, manufacturing process, at least one customization
surface with a millimeter area and field mapping, confirmed facts, and at least
one rights-approved authorized asset.

### ZIP structure

```text
custom-product-package.zip
├─ manifest.json
├─ product.json
├─ customization.json
├─ research/
│  ├─ competitors.json
│  └─ review-insights.json
├─ brand/style.json
├─ compliance/
│  ├─ claims.json
│  └─ completeness-report.json
└─ assets/
   ├─ asset-inventory.json
   ├─ real-product/
   ├─ finished-samples/
   ├─ packaging/
   ├─ print-templates/
   ├─ style-reference/
   └─ competitor-reference/
```

Competitor media appears only in `asset-inventory.json` with
`rightsStatus: reference_only`, `usePolicy: analysis_only`, and
`includedInPackage: false`. Its original bytes are never copied into the ZIP.
Only assets from the `authorized` object domain with database rights status
`approved` can be included.

Every non-manifest file has a SHA-256 checksum and byte size in `manifest.json`.
The package and manifest contain no API keys, tokens, cookies, authorization
headers, or account configuration.

## Amazon Custom employee workflow

The employee SOP is also a tenant-scoped executable workflow. Every product
plan appears in the workflow workspace even before a workflow is started.
Starting a workflow creates one projection row, fourteen ordered step rows, and
the first immutable event.

| Method and route                                                         | Purpose                                  | Required permission |
| ------------------------------------------------------------------------ | ---------------------------------------- | ------------------- |
| `GET /v1/products/custom-workflows`                                      | List progress for every visible product  | `ProductRead`       |
| `GET /v1/products/plans/:id/custom-workflow`                             | Read one product's steps and event log   | `ProductRead`       |
| `POST /v1/products/plans/:id/custom-workflow`                            | Create and start the first task          | `ProductWrite`      |
| `POST /v1/products/plans/:id/custom-workflow/steps/:stepKey/transitions` | Start, block, complete, or reopen a task | `ProductWrite`      |
| `PATCH /v1/products/plans/:id/custom-workflow/steps/:stepKey`            | Edit or clear a completed task note      | `ProductWrite`      |

Step transitions require the current workflow revision:

```json
{
  "status": "blocked",
  "note": "Waiting for the supplier to confirm the customization area",
  "expectedRevision": 4
}
```

The service rejects stale revisions and out-of-order transitions. Blocking
requires a reason. A completed step can reopen only when no later step has
started, and reopening requires a reason. Completing the final step marks the
workflow complete; it does not publish or mutate Seller Central.

A completed task remains editable. Updating its completion note increments the
workflow revision and appends a `step_note_updated` event without changing the
task status, completed count, or current step. Sending an empty note clears the
current note while preserving the immutable edit event.

`amazon_custom_workflows` and `amazon_custom_workflow_steps` are current
projections. `amazon_custom_workflow_events` is append-only and records actor,
step, old status, new status, note, revision, and time. All three tables use
forced PostgreSQL RLS and tenant foreign keys. Application privileges do not
permit workflow-event updates or deletes, and a database trigger rejects them
for privileged callers as well.

### Amazon Studio import

The server-side Amazon Studio importer must call
`inspectCustomProductPackage(bytes)` from `@yummyai/storage` before persisting
or extracting a project. The inspector:

- limits the archive to 25 MB, 500 files, and 100 MB expanded data;
- rejects absolute, backslash, drive-letter, traversal, and sanitized
  traversal paths;
- permits only declared JSON and supported image/design/PDF file types;
- requires every package document;
- compares every declared byte size and SHA-256 checksum;
- validates all documents against the shared contracts;
- rejects credential-like paths or object keys.

After inspection, Amazon Studio may use `product.profile` as product facts,
`customization.definition` and `customization.surfaces` as Custom configuration,
and `competitors` plus `reviewInsights` only for content priority. It must not
promote an unverified fact or a `reference_only` asset into publishable Listing
content.

## Amazon Custom listing materials package

`AmazonCustomListingMaterialsV1` is the final P0 handoff to a Seller Central
operator. It does not publish a listing. It is built only from a ready custom
product profile, an approved Amazon listing version, approved authorized
assets, SKU mappings, A+ assets, a finished sample, and a print/production
template.

| Method and route                                                        | Purpose                               | Required permission |
| ----------------------------------------------------------------------- | ------------------------------------- | ------------------- |
| `GET /v1/products/plans/:id/custom-package/listing-materials/readiness` | Evaluate all eight handoff groups     | `ProductRead`       |
| `GET /v1/products/plans/:id/custom-package/listing-materials`           | Download the immutable ready-only ZIP | `ProductRead`       |

The release gate requires 100% readiness across product facts, SKU mapping,
approved copy, category attributes, price, inventory, condition and FBM shipping settings, MAIN plus eight secondary listing
images, A+ modules, Amazon Custom surface/field mapping, approved production
files, and compliance validation. The ZIP contains operator-readable TXT/CSV,
machine-readable JSON, deterministic media filenames, a readiness HTML report,
and an ordered upload checklist. It excludes research-domain and
`reference_only` media by construction.
