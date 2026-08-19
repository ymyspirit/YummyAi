# ADR-009: Immutable finance evidence and reproducible profit

**Status:** Accepted for P3-D local implementation

## Context

Marketplace settlements, advertising charges, fulfillment fees, supplier
invoices, carrier costs, tax, and exchange rates arrive from different sources
and times. A mutable order-profit column would hide corrections, historical FX
selection, metric changes, and missing costs. Treating an unavailable value as
zero would overstate profit.

## Decision

- Store every provider statement and normalized fact as immutable tenant
  evidence. A reused provider identity or idempotency key must retain the same
  canonical SHA-256 checksum.
- Corrections append a reversal and optional replacement. A reversal exactly
  matches the corrected amount, type, currency, direction, and dimensions.
  Replacement facts require the reversal and retain compatible dimensions.
- Store FX as positive rational numerator/denominator values with source,
  effective time, retrieval time, checksum, and immutable identity.
- Profit definitions are versioned. Revenue, cost, and required fact types are
  disjoint and pinned by every calculation.
- A calculation accepts an explicit statement set and FX set. It selects only a
  supplied direct rate effective at or before each fact, with deterministic
  integer rounding.
- Runs and per-fact contributions are immutable. Complete runs expose totals and
  order, line, SKU, Listing, store, platform, supplier, and period breakdowns.
- Missing required facts, missing FX pairs, or unclassified fact types make the
  run `incomplete`; revenue, cost, profit, and margin remain `null`.
- All finance tables use forced RLS and composite tenant foreign keys.
  `yummyai_app` may update only the current metric identity projection.

## Consequences

Profit can be reproduced from the pinned metric version, statement checksums,
FX checksums, and contribution rows. Corrections do not erase prior evidence.
Operators must explicitly classify newly introduced fact types and provide
historical FX before a run can be complete. Real Amazon/Etsy settlement
retrieval remains an authorized provider acceptance gate; local fixtures prove
normalization and accounting behavior without fabricating provider evidence.
