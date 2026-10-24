# Manual ERP records and operations

The store, supplier, inventory and procurement UI uses the existing authenticated
`apiFetch` boundary and module services. The shared server action has a fixed
operation allowlist, validates input against shared Zod contracts, validates entity
IDs, and returns only public record fields. It cannot forward arbitrary paths or
caller-selected tenant IDs. Nest permission checks and `withTenant()` remain the
authoritative write and tenant boundaries. Form errors retain input, while a
successful write refreshes affected ERP lists. No credentials are returned to
client state.

## UI routes

- `/stores`: create a local Amazon/Etsy store profile using name, platform and
  site. The existing account status remains `pending_authorization`, with no
  credential. Amazon report import can use this profile immediately.
- `/stores/:id`: rename the profile and, before authorization, choose a matching
  authorization mode. Connecting a marketplace is a separate existing action.
- `/suppliers`: create manual supplier records, filter status, search, and edit public metadata.
  Supplier details and the product directory share [versioned supply relationships](product-suppliers.md).
- `/inventory`: create warehouse/location/stock metadata, edit supported metadata,
  and record opening or signed adjustment movements. Stable codes, warehouse
  associations, stock units and existing ledger rows are not rewritten.
- `/procurement`: create a purchase draft, add related master records inline,
  revise draft/rejected orders into a new version, review with the existing
  `procurement:approve` permission, and receive approved orders through the
  existing atomic procurement-to-inventory service.

The procurement workspace now includes optional stock/location status fields.
The new selectors omit inactive choices while preserving already selected lines
when an older purchase draft is opened.

Related-record dialogs are portaled native dialogs, so nested workflows do not
nest HTML forms. Parent form state stays mounted. Searchable selectors use names
and codes, with IDs remaining transport details. Writes disable repeated submit
and closing while pending. Procurement and movement commands retain one
idempotency key per unchanged payload; correcting the payload creates a new key.
If a network response is uncertain, unchanged retry uses the original key. As
with existing APIs, store and master creation do not offer a general idempotency
contract; confirm the list before repeating an uncertain create.

## Added REST contracts

| Route | Permission | Editable fields |
| --- | --- | --- |
| `PATCH /v1/sourcing/suppliers/:id` | `order:write` | name, regionCode, settlementCurrency |
| `PATCH /v1/inventory/warehouses/:id` | `inventory:write` | name, countryCode, timeZone |
| `PATCH /v1/inventory/locations/:id` | `inventory:write` | name |
| `PATCH /v1/inventory/stock-items/:id` | `inventory:write` | name |

`PATCH /v1/marketplace-accounts/:id` additionally accepts `authorizationMode`.
Changing the mode of a credentialed account is rejected; modes must match the
account platform. No new tables, migrations or environment variables are needed.
The supplier contract has a direct `@yummyai/contracts/order/routing` export to
avoid importing the entire server-oriented contract barrel into Next server
actions.

## Boundaries and verification

This change enables internal records and recorded inventory operations. It does
not contact suppliers, pay invoices, authorize stores, publish marketplace
listings, or simulate external fulfillment. UI forms for RFQs, invoices and
replenishment policies remain outside this change.

Verification covers contract validation, safe error responses, redaction,
idempotency preservation, money parsing, metadata edits across two tenants,
existing procurement version/approval/receipt invariants and browser acceptance
through the real API. The `manual-procurement` E2E fixture creates uniquely named
local records, checks desktop and 390 px layouts, and archives only its own master
records using the non-owner tenant role. It reverses its own remaining test stock
through ordinary adjustment commands before archiving. QA purchase, movement and
audit history remain preserved; the fixture does not delete or bypass immutable
ledgers.
