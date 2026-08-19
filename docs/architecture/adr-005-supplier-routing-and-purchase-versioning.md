# ADR-005: Deterministic supplier routing and purchase versioning

**Status:** Accepted for P2-D local implementation

## Context

An approved order line may be fulfillable by a manual supplier, Printify, or Printful. Allocation must be reproducible, tenant isolated, explainable after supplier data changes, and unable to bypass cost, quality, customization, or human-approval controls.

## Decision

- Supplier capability, quote, capacity, routing-policy, candidate, routing-event, and purchase-order-version records are append-only for the application role. Supplier, routing-decision, and purchase-order rows are mutable current projections with append-only evidence behind them.
- One evaluation pins the latest applicable capability, quote, capacity, and explicitly selected policy version. The input checksum includes the evaluation timestamp and canonical sorted inputs.
- Eligibility is evaluated before scoring. Eligible candidates are sorted by total score, unit cost, lead time, then supplier ID; every score uses integer basis points.
- Cost/risk thresholds produce `pending_approval`. A manual override can select only an eligible recorded candidate and always returns to `pending_approval` with actor, reason code, and reason evidence.
- Approval creates or advances an immutable purchase-order version. `awaiting_routing -> in_production` requires the latest decision for every line to be approved and pinned by the current approved purchase-order versions.
- Printify and Printful implement one production-order connector contract. Draft creation and charge/production submission are separate calls; P2-D never auto-confirms as a side effect of routing.

## Consequences

Supplier data changes create new evidence rather than changing a prior decision. Re-routing creates a new decision version. Operational users can explain automatic selection and manual intervention from persisted candidates and events. Real provider submission remains an online acceptance gate and starts only from later production orchestration with purpose-bound PII access and encrypted credentials.

## References

- [Printify Orders API](https://developers.printify.com/)
- [Printful Orders API](https://developers.printful.com/docs/)
