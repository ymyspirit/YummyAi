# Ivyea reference alignment for YummyAI

Reviewed on 2026-10-13 against immutable source revisions:

- [ivyea-agent fb6bcfe](https://github.com/Hector-xue/ivyea-agent/tree/fb6bcfe2593bd69cb2d720a261eaa65c1f7961f7), MIT.
- [IvyeaOps b6523be](https://github.com/Hector-xue/IvyeaOps/tree/b6523be65006aa3e45ce88cdf583d93fd1d478c9), AGPL-3.0.

This is a source/design comparison, not a runtime certification of either
project. The implementation uses YummyAI services, contracts, tenant transactions
and existing UI. No upstream source or dependency was copied into the application.

## Adopted principles and native implementation

| Reference evidence | Useful principle | YummyAI implementation and decision |
| --- | --- | --- |
| Agent `ivyea_agent/task_runner.py`: persistent status, steps, events and resume metadata | Resume the same identified task and explain the next step | Existing `/ai-tasks` preserves assistant runs, evidence, budget and business links. The new home-page fulfillment queue extends this to production, delivery and logistics; opening an uncertain purchase resumes its original task |
| Ops `server/app/services/agent_session_service.py`: persisted sessions and summary checkpoints | Closing a page should not lose work | Existing Worker jobs, immutable order/design versions and recoverable production checkpoints remain authoritative; the UI reads them instead of launching work again |
| Ops `docs/decisions/0026-cockpit-daily-ops-panels.md`: own-business exceptions, timestamps and actionable destinations | An operations dashboard needs current internal work, not only market research totals | Added current-state fulfillment attention, exact counts, domain permission states and direct record links. Homepage date-range summaries stay separate from currently actionable work |
| Agent `ivyea_agent/shadow.py` and the documented dry-run guardrails | Record advice and distinguish recommendations from executed results | Native advertising recommendations retain evidence, adoption/execution events and later observations. Observed spend/orders are not labeled causal savings; no automatic ad writes are introduced |
| Ops agent/visual workbench architecture and README review stages | Tie assistant outputs to business objects and reviewed artifacts | Sales-plan launch, private order design, pinned rules, full-size production exports and package checks keep their existing review gates. A model answer is not an operator approval or factory acceptance |
| Ops knowledge governance workflow | Source revisions and published knowledge need separate states | Native knowledge governance retains import, evidence, draft/diff/review/publish and retrieval scope. Knowledge never overwrites ERP product facts, manufacturing constraints or authorization |

## Concrete gap closed in this change

Before this change, the home action center aggregated capture failures, generic
design deadlines and background jobs. Operators had to inspect production,
logistics and delivery pages separately to find an uncertain carrier response,
an uncollected label, a missed production date or a missing factory receipt.

The new [fulfillment attention projection](../integration/fulfillment-attention.md)
reads those states under current permissions. It uses stable original record
links, preserved URL filters and a visible next action. Carrier uncertainty
links to reconciliation, factory acceptance removes the receipt todo, and a
new production version supersedes old delivery work without rewriting history.
Loading, failed reads, denied sources and genuinely empty queues are distinct.

## Scope audit

The follow-up [sales preparation Agent](../integration/sales-plan-agent.md) applies
the persistent-plan and bounded-loop principles in Agent ADR 0026 and the Ops
session checkpoint design. It stores a creator-scoped plan in the existing
catalog event ledger, reconciles stable business request IDs, and checks actual
draft results. Paid analysis retains explicit source/model confirmation and
existing budget controls. The fixed tool boundary ends at a draft ready for
review; it does not approve, publish, purchase labels, or introduce general coding
sessions. Four local iterations per command and two confirmed analyses per run
bound execution. This is a native implementation, not upstream runtime validation.

- Reference discovery: both current heads pinned and source paths reviewed.
- Existing ERP preserved: no parallel application, alternate database or imported
  agent runtime; no new secret storage or independent business truth.
- Business optimization: current production/logistics/factory attention now
  reaches the existing action center and can reopen the exact task/package.
- Transaction boundaries: reading a queue never purchases, publishes, approves
  or submits; existing APIs and their authorization/evidence gates still own
  every write.
- Data/UX verification: tests cover tenant separation, limited permissions,
  current-state transitions, pagination, failure recovery and actual desktop/
  narrow-screen operation. See the integration runbook for repeatable commands.

General coding-agent sessions, arbitrary plugins/MCP execution, the upstream
local SQLite stores and copied browser-based seller actions are outside this
ERP change. Ads counterfactual evaluation requires real comparable reports and
an explicit business experiment; its absence cannot be filled by invented ROI.

The [business task workspace](../integration/business-tasks.md) now shares a
stage/evidence view across sales preparation and order fulfillment. Its order
coordinator reads the existing domain services and can prepare a version-pinned
factory package with a stable business request key. Factory groups, current
logistics pins and historical package references are checked again before any
write. Existing services remain responsible for approval, private storage,
payments, receipts, quality and dispatch. Measured run metrics explicitly report
their coverage and unknown values. No upstream runtime or source code is copied.
