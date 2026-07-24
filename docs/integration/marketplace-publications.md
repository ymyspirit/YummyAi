# Marketplace publications

P1 publication starts from one current, approved Listing version. The API performs preflight, writes an immutable request plus a `queued` or `scheduled` event, and enqueues only the request ID. The publication Worker loads credentials from the encrypted tenant store and revalidates the pinned resources before calling a marketplace.

## Listing publication settings

The approved Listing version must contain platform-matching `publication` settings:

- Amazon: Product Type Definition name plus schema-shaped `attributes`. A request also selects one approved Listing variant by `variantSkuId`.
- Etsy: price, quantity, `whoMade`, `whenMade`, taxonomy node, shipping profile, readiness profile, and optional shop section/supply flag. Multi-variant Listings also require a complete inventory mapping. Enabled personalization requires instructions and may pin a maximum character count.

Refresh capabilities before approving the Listing so the version references current Amazon product-type schemas or Etsy profile IDs. Publication is rejected when the latest capability snapshot is expired or does not contain the selected target.

## API

`POST /v1/marketplace-publications` requires `listing:publish`:

```json
{
  "accountId": "019...",
  "listingId": "019...",
  "listingVersionId": "019...",
  "marketplaceId": "ATVPDKIKX0DER",
  "variantSkuId": "019...",
  "scheduledFor": "2026-07-25T08:00:00.000Z"
}
```

`variantSkuId` is required for Amazon and rejected for Etsy draft creation. `scheduledFor` is optional, must be a future timestamp no more than 90 days away, and creates a BullMQ delayed job. Repeating the same account, Listing version, marketplace, and action returns the same request; it cannot create a second external action or change its immutable schedule.

When a delayed job becomes runnable, the Worker appends `queued` after the original `scheduled` event before runtime validation and `processing`. This preserves the distinction between work that is waiting for its planned time and work that has entered the execution queue.

- `GET /v1/marketplace-publications?listingId={id}&accountId={id}&limit={1..100}` requires `listing:read` and returns tenant-scoped requests with their latest event projection. Filters are optional and support the Listing publication ledger and store diagnostics without exposing event payload internals.
- `POST /v1/marketplace-publications/:id/continue` requires `listing:publish`. It is accepted only for an Amazon `validation_passed` request or an Etsy `draft_created` request with a recorded external Listing ID. The response is an idempotent child request for `amazon_submit` or `etsy_activate`; the P1-D parent remains immutable.
- `POST /v1/marketplace-publications/:id/cancel` requires `listing:publish` and a non-empty `reason`. It appends `cancelled` only while the request is `scheduled`, `queued`, or `retry_pending`; processing or externally accepted work cannot be presented as cancelled. Queue cleanup is best effort because the Worker independently treats the appended cancellation as terminal before connector execution.
- `GET /v1/marketplace-publications/:id` requires `listing:read` and returns the current event projection.
- `GET /v1/marketplace-publications/:id/events` requires `listing:read` and returns the append-only history.

Responses expose parent/source linkage, request IDs, checksums, asset counts, normalized issues, and external Listing/submission/media identifiers. They never expose provider payloads, object keys, authorization headers, tokens, or encrypted credential envelopes.

## Platform semantics

Amazon P1-D calls Listings Items `putListingsItem` with `mode=VALIDATION_PREVIEW`. `validation_passed` means the provider preview did not report a blocker; it does not mean an Amazon Listing or draft exists. P1-E `amazon_submit` performs the real `putListingsItem`, records acceptance, then reads Listings Items summaries/issues. `ACCEPTED` is not shown as published until the read state is buyable or discoverable.

Etsy P1-D calls `createDraftListing` with the current `readiness_state_id`. A successful event is `draft_created` and contains the Etsy Listing ID. P1-E configures full inventory and the current personalization endpoint when present, reads only private authorized assets, verifies pinned SHA-256 checksums, uploads one to twenty images in the approved main/media order, activates the draft, and confirms the resulting state.

Every completed external step appends evidence before the next step starts: `configuration_applied`, `media_uploaded`, `activation_accepted`, or `submission_accepted`. A retry resumes after the latest recorded step instead of repeating it. Only a process interruption while a mutation is in flight without a recorded result enters `reconciliation_required`.

## Failure behavior

- Authorization failures revoke the local account and stop publication.
- Validation/conflict failures are terminal for the pinned Listing version.
- Rate limits, pending status reads, and safe read/preview failures retry with BullMQ backoff while attempts remain. A valid provider `Retry-After` window lengthens the exponential delay up to fifteen minutes; it cannot force a tight retry loop. Exhausted status polling remains explicit as `sync_pending` for later reconciliation.
- A lost Etsy create response, an Etsy `5xx`, an invalid success response, or a failed Etsy external-ID writeback becomes `reconciliation_required`; automatic retry is blocked to prevent duplicate drafts.
- Research-domain, deleted, changed, rights-unapproved, or checksum-mismatched assets fail before connector invocation or upload.
- Scheduled or queued requests can be cancelled without mutating their request row or prior events. Cancellation never rolls back a provider mutation that has already started.
- Worker replicas serialize connector execution per tenant/account with a database advisory lease acquired before `processing`. Separate accounts remain independent; provider quota windows are applied to retries, while successful-response quota telemetry remains a separate P1-G control.

Real release evidence requires an approved Amazon non-production SKU preview plus submit/status check and an approved Etsy test-shop draft plus configure/upload/activate/status check. CI uses mock connectors and cannot satisfy that release gate.

## Online price and inventory reconciliation

Online operations must reference a published `amazon_submit` or `etsy_activate` request. The API derives the account, marketplace, external Listing ID, and pinned provider payload from that request; clients cannot supply a raw external target.

- `POST /v1/marketplace-listing-syncs` requires `listing:publish`. It accepts `accountId`, `listingId`, `listingVersionId`, `sourcePublicationRequestId`, and `action` (`read` or `push_price_inventory`).
- `GET /v1/marketplace-listing-syncs?listingId={id}&accountId={id}&limit={1..100}` and `GET /:id/events` require `listing:read`.
- Amazon reads Listings Items attributes and patches only `purchasable_offer` and `fulfillment_availability` from the approved payload.
- Etsy reads the Listing and inventory resources with the processing-profile-compatible `legacy=true` inventory shape. Money objects and provider-only product/offering IDs are normalized before comparison; inventory writes reuse the same writable projection as draft configuration.

Requests and events are immutable and tenant-scoped. `completed` means the normalized online snapshot matches the approved state, while `drift_detected` preserves the observed difference. Any interrupted or uncertain mutation enters `reconciliation_required`; a new read must establish provider state before another push.

## Site replication and approval automation

- `POST /v1/listings/:id/replications` accepts `sourceVersionId`, `targetMarketplaceId`, `targetLocale`, and optional localized field overrides. `GET /v1/listings/:id/replications` returns immutable lineage.
- `POST /v1/marketplace-automation-rules`, `GET /v1/marketplace-automation-rules`, `PATCH /v1/marketplace-automation-rules/:id`, and `GET /:id/runs` manage tenant rules and immutable run evidence.

Replication is same-platform only and creates a new draft that must be validated and approved independently. The initial automation trigger is `listing_approved`; conditions can constrain Listing, platform, locale, and minimum completeness. Actions enqueue an ordinary publication preview/draft or online sync request and therefore cannot bypass account, capability, asset, validation, approval, or idempotency gates.
