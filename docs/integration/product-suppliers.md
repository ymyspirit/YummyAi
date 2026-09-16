# Product supplier relationships

Products and fulfillment supplier master records now share a many-to-many supply
directory. `/products?plan=<id>#product-suppliers` lists suppliers for a product;
`/suppliers/<id>` lists the products supplied by that supplier. The supplier index
defaults to active records and includes status filters. Counts use distinct
products/suppliers, so several SKU relationships do not inflate them.

## Data and API

- `product_supply_links`: stable tenant/product/supplier/optional-SKU identity.
  A null SKU denotes general product information before SKU development.
  A concrete SKU must belong to the selected product's SPU. Existing product
  approval requirements still govern SPU/SKU creation.
- `product_supply_versions`: immutable supply terms, stock mapping, quote amount
  in minor units, currency, MOQ, lead time, effective period, sample state,
  preference, supply status, notes and supported fulfillment purposes.
- `inventory_purchase_orders`: optional `source_supply_version_id` and request
  hash preserve the originating quote; `purpose` distinguishes `general`,
  `custom_order`, and `fba_replenishment`. Source identity and purpose are immutable.

Migration `0069_product_supplier_links.sql` adds composite tenant foreign keys,
forced RLS, application-role grants and immutability guards. Its journal timestamp
is greater than migration 0068, whose timestamp is ahead of the local clock.
Do not regenerate a journal entry with a lower timestamp than its predecessor.

All business operations run through `withTenant()` using the non-owner role.
Tenant context is supplied by authenticated membership. Public views are parsed
with shared schemas and omit tenant IDs and supplier connection references.

| Route | Permission | Behavior |
| --- | --- | --- |
| `GET /v1/product-suppliers/workspace` | `procurement:read` | Supply relationships and public form choices |
| `GET /v1/product-suppliers/:id/history` | `procurement:read` | Immutable versions, newest first |
| `POST /v1/product-suppliers` | `procurement:write` | Create one product/supplier/specification relationship |
| `POST /v1/product-suppliers/:id/revisions` | `procurement:write` | Append a version using `expectedVersion` |
| `POST /v1/product-suppliers/:id/purchase-drafts` | `procurement:write` | Create an inventory procurement draft from a pinned quote |

Create/revise commands bind each idempotency key to the normalized request.
The same key and body replay the original result; another body conflicts.
Per-product locks serialize primary-supplier and version changes. There can be
only one active primary supplier for each product/specification.

The procurement module owns purchase writes. Source quote validation and draft
creation share one tenant transaction. The server selects supplier, material,
currency and price; the client selects quantity, destination, expected date and
purpose. Stale, inactive, failed-sample, missing, future or expired quotes cannot
create drafts. MOQ and active supplier/material/destination checks still apply.
An uncertain retry returns the original draft even after a quote changes.
Subsequent procurement revisions remain part of the existing immutable purchase
version history; the source quote denotes the draft's original terms.

## Operational boundary

The directory distinguishes buyer-specific customization and FBA replenishment.
A procurement destination is the actual receiving/inspection location. Recording
a local FBA warehouse is not proof that Amazon has received inventory. FBA inbound
plans, carton labels, shipment submission, in-transit milestones and remote receipt
reconciliation are not created by this procurement action.

Buyer customization requirements, proof approval and production/shipment progress
remain in the existing order modules. Creating a supply relationship does not
automatically route an order or transmit it to a supplier. Automated routing still
requires its supported SKU, region/process capability, capacity and routing quote
evidence. The product directory's early `supplier_candidates` remain clearly
labelled research candidates; names are never used to silently merge identities.

## Verification

Contract tests cover dates, money and safe purchase URLs. Integration coverage
checks many-to-many relationships, SKU ownership, tenant isolation, primary
uniqueness, version conflicts and replay, immutable history, valid quote/MOQ
gates and procurement price preservation. The browser fixture runs actual
Web → authenticated API writes and checks desktop and 390 px layouts:

```powershell
$env:E2E_REAL_PRODUCTS = '1'
pnpm test:e2e product-supply-procurement.spec.ts
Remove-Item Env:E2E_REAL_PRODUCTS
```

`E2E_REAL_PRODUCTS` is test-only configuration; it disables the product demo
fixture in the Playwright-managed web server. Stop normal API/Web development
servers before running E2E in the same checkout. The fixture uses unique QA
names, discontinues its supply relationships through the API and archives only
its own master records. Quote, purchase and audit history remain preserved.
