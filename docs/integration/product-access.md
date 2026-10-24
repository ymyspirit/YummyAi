# Product controls and personal-session permissions

Product controls reuse the current ERP session and the existing canonical
`@yummyai/authz/permissions` constants. The client-only entry exports values and
types, without database or service code. Web adds one internal workspace link;
removing that exact importer block reproduces the prior lockfile byte hash.
No external dependency version or database migration changes.

## UI authority boundary

`ErpIdentityContext` separates an actual personal session, an explicitly supplied
local developer identity and a missing/unavailable context. Missing context or
`session:null` never implies developer permissions. Only the server ERP layout
passes `localDevelopment` from the existing non-production loopback mode.
`useErpAccess` requires all named permissions for composite operations and does
not treat an empty requirement list as a grant.

These checks control visible/editable UI. Existing BFF, business-owner API,
membership, object/tenant checks and business-state gates still authorize every
command. A client context does not grant API or Agent authority, establish object
ownership or certify that Team/Self scopes are implemented throughout the platform.
The identity boundary continues to clear private content after current-authority
change and discard older successful responses.

## Covered product controls

| Operation | Explicit current-role requirements |
| --- | --- |
| Legacy product plan create, transition, schema and facts | ProductWrite, plus original editable business state |
| SPU, specification, combination and recipe actions | ProductWrite |
| Artwork registration or modification | ProductWrite and DesignReview |
| Artwork archival/restoration | ProductWrite |
| Listing draft creation | ListingWrite |
| Channel-package sealing | ListingReview, ProductWrite, ProductRead, DesignRead, AssetRead and ListingRead |
| Store SKU mapping | StoreManage and ProductWrite |

These are explicit entry requirements, not substitutes for nested owner checks,
input quality, current production versions or state-machine conditions. The
original business owner remains authoritative for an operation's actual outcome.

The product directory hides create/development actions from readers. Existing
customization fields remain readable; mutation inputs and the save flow are not
offered as writable controls. An absent product-facts profile uses an honest
read-only empty state instead of a disabled creation form. Locked business phases
remain locked even for a writer.

Current product-development, SPU and artwork pages follow the same role rules.
Direct `form=1`, composition or edit URLs cannot display a write form without the
required role. Readable SPU details, sales-plan navigation and source facts remain
available. A read-only empty state does not instruct the user to click a hidden
write action. SKU Listing/package/mapping controls check their distinct permissions.

Pure client schema controls stay read-only/disabled until initialization completes;
their server-rendered appearance must not accept an interaction that cannot yet
update the saved schema.

Customization draft rows use stable local identities, so changing a field key does
not recreate its input and lose focus. Invalid draft state disables the original
save action; it cannot report success by silently submitting the last valid schema.
The original API schema and locked-phase checks remain authoritative. This is a
B07 editing-reliability slice, not completion of cross-record draft/recovery work.

## Verification and remaining B06

The disposable product-access profile uses real personal OIDC sessions, Web,
server actions, API and tenant transactions. It verifies readable facts without
write controls, direct unauthorized API writes, write-form URLs, actual product
creation and schema persistence, partial role withdrawal, discarded old identity
responses and the separate artwork-review requirement. Local synthetic identities
prove the application's protocol path, not real IdP deployment.

~~~powershell
pnpm test:e2e:order-daily --suite=product-access
pnpm test:e2e:order-daily --suite=erp-identity
~~~

These profiles share owned ports and run sequentially. Existing local developer
sales-plan behavior is verified separately. Broad B06 work remains: audit the
remaining module controls, nested command permissions, actual object filters,
Team/Self and mixed-role scope semantics, private files and history. A UI-only
role check does not complete that audit or a platform stage.

## Permission-specific product ownership (2026-10-18)

Legacy plan controls now pass the actual plan owner to the shared pure policy. A self writer can create and edit an owned plan while a foreign visible plan explicitly shows editing scope restrictions. The personal authority fingerprint also contains each operation scope. Core commands, related facts packages and remaining modern workspace/team policy are described in [product authority](product-authority.md).
