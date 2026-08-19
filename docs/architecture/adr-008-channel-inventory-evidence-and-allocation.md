# ADR-008: Channel inventory evidence and allocation projections

**Status:** Accepted for P3-C local implementation

## Context

The P3-A balance projection distinguishes physical, provider, in-transit, and
virtual quantities, but it cannot explain whether a provider quantity is FBA,
FBM, overseas/3PL, supplier, quarantined, damaged, or sellable. Reusing one
mutable balance field for channel availability would also lose the provider
checkpoint, policy version, caps, buffers, and allocation order that produced a
Listing quantity.

## Decision

- Provider and internal inventory input is normalized into an explicit stock
  source and condition before it reaches the API.
- Each provider scope advances an immutable checkpoint sequence and appends an
  immutable snapshot plus normalized lines. A repeated idempotency key must
  carry the same checksum; a checkpoint cannot move backwards.
- Stock source and stock condition are independent dimensions. In-transit,
  quarantine, damaged, supplier, and virtual quantities remain visible even
  when a policy excludes them.
- One channel allocation policy identity exists per stock item. Policy content
  is immutable and versioned; the identity only advances its current version.
- A calculation pins the exact policy version and current snapshot checksums.
  It writes an immutable run and one projection per ordered channel target.
- The global safety buffer is removed before channel allocation. Channels then
  consume stock in priority order. A channel cap limits gross allocation and a
  channel buffer is withheld from its published quantity.
- Online Listing inventory writes derive their SKU-to-stock-item mapping from
  the approved Listing and catalog. They require a projection from the current
  policy version, reject stale projections after new stock evidence, and fail
  when requested quantity exceeds the allocation.
- Interrupted or outcome-uncertain marketplace mutations append a dedicated
  channel reconciliation identity and event. They are not retried
  automatically.
- Snapshot, checkpoint, policy-version, run, projection, and reconciliation
  event tables are append-only for `yummyai_app`. All tenant-owned tables use
  forced RLS and composite tenant foreign keys.

## Consequences

Every displayed channel quantity can be traced through projection, calculation
run, policy version, and provider snapshot. Operators must rerun allocation
after new inventory evidence or a policy revision. This is intentionally
fail-closed and may temporarily block a Listing inventory push. Real Amazon,
Etsy, and 3PL report retrieval still requires authorized provider acceptance;
local implementation proves normalization, persistence, allocation, and
reconciliation behavior without fabricating provider facts.
