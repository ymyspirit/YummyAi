# ADR-004: Order kernel and customer PII boundary

- Status: Accepted
- Date: 2026-07-20

## Context

P2 introduces marketplace orders, buyer contact details, and shipping addresses. Provider payloads can arrive more than once, out of order, or with different protected fields depending on authorization and region. The ERP must preserve operational history without exposing customer PII to ordinary order readers, logs, jobs, diagnostics, or unrelated modules.

## Decision

Use a tenant-scoped order kernel with four separate data classes:

1. `orders` is the mutable workflow projection. It contains provider identity, normalized state, non-sensitive totals, counts, and timestamps.
2. Order lines, external references, source snapshots, domain events, exception identities/events, and protected-access events are append-only records.
3. Source snapshots retain a redacted provider projection plus its checksum. Raw protected values never enter the snapshot JSON.
4. Buyer contact and shipping address fields live only in `order_protected_details` as an AES-256-GCM envelope encrypted with a dedicated `ORDER_PII_ENCRYPTION_KEY`.

Public order reads never join or decrypt protected details. A separate fulfillment-detail command requires `order:pii:read`, a constrained access purpose, and an audit record written in the same tenant boundary before plaintext is returned. Irreversible anonymization has a separate `order:pii:anonymize` permission, refuses unexpired envelopes, uses optimistic order/envelope versions, removes ciphertext and country data, and retains only checksum-safe event/audit evidence. Jobs carry only tenant, account, snapshot, event, and correlation identifiers; they never carry buyer or address fields.

Provider identity is unique by tenant, marketplace account, platform, and external order ID. A source delivery is unique by tenant, account, platform, and external event ID. Replaying a delivery returns the existing normalized order and never creates a second order, line, or initial event.

P2-B treats every distinct provider event as immutable evidence. A late event appends a source snapshot and `provider_update_received` event, then updates only the provider-status projection. Account/platform/stream ingestion runs use a monotonic checkpoint version and a partial unique index so two local workers cannot both claim an active stream. Static risk records exclude buyer fields and raw upstream error bodies.

P2-C captures one immutable customization requirement per order line and appends encrypted mapping versions beneath it. The requirement pins the exact `CustomizationSchema` snapshot and holds only mutable gate status/deadline projections. Customer file intake metadata points only to a tenant `quarantine` object; scan results, proof versions, and customer decisions are append-only evidence. A clean scan copies bytes into a new `authorized` object and records `customer_provided` rights rather than mutating the quarantine object.

P2-F separates immutable shipment versions from mutable shipment and writeback projections. Approval pins package allocations and encrypted reviewer evidence. The queue carries only a writeback request ID. The Worker records dispatch before a marketplace mutation; a missing outcome becomes reconciliation instead of an automatic retry. Marketplace acknowledgement and carrier delivery are separate evidence streams.

P2-G applies the same split to after-sales. Case and return-shipment rows are mutable queue projections. Customer contacts, decision versions, return tracking, replacement lineage, and responsibility evidence are append-only. Free text is encrypted and public projections retain only structured codes and checksums. Refund amounts are bounded by the normalized order total/currency; replacement lineage is tenant-scoped and acyclic.

Scheduled fulfillment automation uses a mutable task projection plus append-only events. The queue carries only the task ID. Tenant policy caps hourly creation and attempts; cancellation is enforced when a delayed job claims the database row. Repeated failures become dead letters, while scans that find uncertain provider or retention work stop in reconciliation and notify the requesting operator. Manual reasons are encrypted.

Catalog matching is a one-time fulfillment decision. An order line first tries an authorized publication's external Listing ID and historically approved version, then an active SKU and the SKU's current approved Listing version. The resulting `order_line_catalog_links` row is append-only; later catalog approvals do not repoint historical order lines.

Main workflow state and side state are independent. A main transition locks the order, validates the expected event sequence and transition graph, updates the projection, and appends one event in the same transaction. Holds and cancellation append their own events. Exceptions have immutable identities and append-only open/resolve event streams; resolving an exception does not rewrite fulfillment history.

## Invariants

1. Every order-domain query runs through `withTenant()` and the forced-RLS application role.
2. Public views contain no buyer name, email, phone, address lines, postal code, or encrypted envelope.
3. Protected values are decrypted only inside a scoped callback and are never placed in audit metadata.
4. Source snapshots and append-only history tables grant the application role only `SELECT` and `INSERT`.
5. One idempotency key can append at most one event for an order.
6. Event sequence is strictly increasing per order and state projection changes cannot commit without the matching event.
7. An `on_hold` or `cancelled` side state blocks ordinary main-state transitions.
8. Provider state remains separate from local workflow state and cannot bypass local transition guards.
9. PII anonymization can remove the expired encrypted envelope without deleting non-sensitive order or event history; it is independently authorized, optimistic, idempotent, and irreversible.
10. P2-A fixture adapters are deterministic test infrastructure, not evidence of real marketplace order ingestion.
11. Only one ingestion run may be active per tenant, account, platform, and stream; checkpoint advancement uses optimistic version matching inside the tenant transaction.
12. Collected/reported counts, unresolved catalog mappings, and missing protected fields remain explicit and never convert into fabricated values.
13. Late protected provider details advance the encrypted envelope version only while its status is `protected`; anonymized envelopes are never repopulated.
14. Customization values and provider file references never enter public summaries, job payloads, scan diagnostics, or audit metadata.
15. A customization file cannot enter the authorized domain without matching tenant prefix, length/checksum integrity, supported schema policy, and a clean malware scan.
16. Proof versions and final customer decisions are append-only; one proof has at most one serialized final decision and timeout never means approval.
17. Shipment writeback can reference only the current approved immutable version, and active approved versions cannot exceed ordered line quantities.
18. Marketplace acknowledgement advances shipment state but never proves delivery; order completion requires delivered evidence for every acknowledged package quantity.
19. Customer contact text, decision reasons, and responsibility details never enter ordinary API reads or audit metadata.
20. A refund decision cannot exceed the normalized order total or change its currency, and does not itself prove an external refund mutation.
21. Returns require a current approved decision and resolve only from delivered tracking evidence; replacement links cannot create cycles.
22. Fulfillment automation cannot exceed its tenant quota or persisted retry budget, and queue delivery cannot override a cancelled projection.
23. Attention/reconciliation scans identify work but cannot fabricate an external outcome or automatically delete expired protected details; a permitted operator must invoke the explicit retention command.

## Consequences

- Ordinary operators can work from a safe order inbox without receiving customer PII.
- Fulfillment access is purpose limited and auditable, at the cost of a separate permission and read path.
- Event history supports replay, diagnosis, and late provider updates without treating mutable rows as evidence.
- P2-B connectors must normalize and redact provider payloads before persisting a source snapshot.
- Fixture-tested HTTP adapters and local browser evidence are not substitutes for authorized-store pagination evidence.
- Real Amazon/Etsy order acceptance remains blocked until authorized stores and protected-data roles are available.
