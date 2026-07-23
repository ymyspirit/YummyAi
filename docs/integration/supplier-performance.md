# Supplier performance integration

P3-E calculates supplier scorecards from existing production, quality,
procurement, invoice, and capacity evidence. It does not accept manually entered
scores, retrieve supplier credentials, or change supplier routing.

## Evidence boundary

The service derives:

| KPI | Evidence |
| --- | --- |
| Quality | Quality inspections weighted by the latest production quantity |
| On-time delivery | Production completion versus expected completion and procurement receipt versus the pinned purchase-order expected date |
| Price variance | Supplier invoice accuracy |
| Response time | First quote time versus RFQ creation and the versioned response target |
| Acceptance | Submitted production work acknowledged by the supplier |
| Cancellation | Production and inventory purchase-order cancellation evidence |
| Capacity adherence | Assigned production completed within the matching supplier capacity window |

Only rows inside the requested evaluation window and available by the evidence
cutoff participate. Every persisted metric retains raw values, sample count, and
source references. Missing or insufficient evidence follows the pinned
definition policy: `exclude`, `zero`, or `incomplete`.

## API

| Method | Route | Permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/v1/supplier-performance/workspace` | `supplier_performance:read` | Read suppliers, current definitions, recent scorecards, metrics, and diagnostics |
| `GET` | `/v1/supplier-performance/scorecards/:runId` | `supplier_performance:read` | Read one immutable scorecard and its seven metrics |
| `POST` | `/v1/supplier-performance/definitions` | `supplier_performance:review` | Create a definition or append a new version |
| `POST` | `/v1/supplier-performance/scorecards` | `supplier_performance:review` | Calculate a scorecard from a pinned definition and evidence window |

The workspace excludes tenant IDs, actor IDs, idempotency keys, protected
production notes, raw supplier payloads, credentials, and unrestricted source
text.

## Replay and operational use

Definition and calculation commands require an idempotency key. An exact replay
returns the existing immutable result; changed content with the same key is a
conflict. A new evaluation window, cutoff, or definition version requires a new
command.

Scorecards support review and comparison only. Any routing-policy revision must
go through the existing supplier-routing approval and versioning path rather
than mutating operational state from this integration.
