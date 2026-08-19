# ADR-010: Reproducible supplier performance from immutable evidence

**Status:** Accepted for P3-E local implementation

## Context

Supplier performance combines production, quality, procurement, invoice, and
capacity facts that arrive at different times. A manually edited supplier score
would hide its source evidence, evaluation window, weighting, missing samples,
and later corrections. It could also become an unsafe shortcut into supplier
routing.

## Decision

- Derive the seven KPIs `quality`, `on_time_delivery`, `price_variance`,
  `response_time`, `acceptance`, `cancellation`, and `capacity_adherence` only
  from existing immutable P2/P3 evidence.
- Version KPI definitions. Each version pins all seven metric weights, minimum
  sample counts, the response-time target, reason code, missing-data policy, and
  canonical checksum.
- Every scorecard pins the supplier, definition version, evaluation window,
  evidence cutoff, input checksum, and calculation time.
- Persist one immutable metric row per KPI with score, raw
  numerator/denominator, raw unit, sample count, and evidence references.
- `exclude` reweights only sufficiently sampled KPIs; `zero` assigns zero to
  insufficient KPIs; `incomplete` returns no overall score unless every KPI
  meets its minimum sample.
- Reusing an idempotency key is valid only when the canonical input checksum is
  unchanged. Changed payloads conflict instead of replacing evidence.
- Definition versions, scorecard runs, and metric rows are append-only.
  `supplier_kpi_definitions` is the only mutable current-version projection.
- All tables use forced RLS and composite tenant foreign keys. Safe workspace
  views exclude tenant IDs, actor IDs, idempotency keys, and unrestricted source
  text.
- Scorecards are analytical output. They cannot update supplier routing,
  purchase orders, production assignments, or capacity.

## Consequences

An operator can reproduce a supplier score from the pinned definition, evidence
window, cutoff, raw values, and referenced facts. Missing evidence remains
visible and cannot become a fabricated score. New evidence requires a new
scorecard run. Routing changes remain a separate reviewed and versioned
decision. Authorized supplier-provider acknowledgement is still an external
acceptance gate; local scorecards use only evidence already persisted by the
application.
