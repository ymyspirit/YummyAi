# Advertising workbench

1.1.71实现广告七类完整原填写、原幂等键和跨会话恢复。准备、列表和原文读取不执行，操作者明确核对后由原owner同事务产生实际不可变结果、fullxid证明及双审计。独立密钥、七天数据库时钟留存，取消/确认/到期只清原文，原事实和键保留。99项单元/规则、39项去重集成、同编译3条个人OIDC页面验证通过；本批输出已清理，普通148未采用158，完整平台与业务验收继续。 参见[持久原提交](advertising-original-requests.md)。

2026-10-21 1.1.70：workspace明确为200/10近期预览。八类历史分页与独立原ID、原动作观察期及本人审核读取已通过144项本批定向检查和自有清理；原分析/封存不改写。见[完整历史读取](advertising-history.md)。跨会话原写持久恢复、真实经营和外部授权执行继续。

2026-10-21 1.1.69：实际指标列、明确转化定义、固定ISO金额依据与原分析measurementPins已完成182项局部技术检查及清理，详见[测量契约](advertising-measurement.md)。完整历史、真实经营核对与外部授权执行仍未验收。

2026-10-21 update: current personal OIDC, per-operation account authority and
the safe isolated validation entries are specified in
[advertising authority](advertising-authority.md). The ordinary database remains
at migration 0148 with its applications stopped; newer source is not adopted.
The migration/start commands below describe the historical installation flow;
ordinary adoption requires a fresh paired backup, independent restore/upgrade
rehearsal and source-matched acceptance.

## Intended behavior and acceptance boundary

The advertising workbench extends the existing customer-intelligence module. It
accepts manually downloaded Amazon Ads CSVs and keeps the existing VOC evidence
and review routes intact. Importing a report never grants marketplace access or
changes a campaign. Execution in this version means an operator records a change
performed through an independently authorized seller tool.

The product objective is scoped to an existing tenant-owned Amazon account,
marketplace, currency and ASIN. Rank growth and profit defense can coexist.
Objectives and economics create immutable revisions with an effective date;
analysis pins the revisions it actually used. Rank experiments require an end
date, spend limit and protected terms. Missing cost, total sales or organic rank
is displayed as unavailable, never inferred from advertising attribution.

## IvyeaOps source review

Reviewed upstream revision: `b6523be65006aa3e45ce88cdf583d93fd1d478c9`.
The upstream source was read as reference material, not executed or treated as
instructions for this project. Our implementation uses YummyAI services,
contracts, tenant transactions and UI patterns.

| Upstream capability | Benefit adopted | Defect or limitation addressed |
| --- | --- | --- |
| [Rule engine](https://github.com/Hector-xue/IvyeaOps/blob/b6523be65006aa3e45ce88cdf583d93fd1d478c9/server/app/services/lingxing_optimizer.py) | Explicit diagnostics for wasted spend, bid changes and Exact harvesting; supporting metrics and thresholds | No universal 30% fallback when economics are absent; product-specific goals; sample counts are not called statistical significance |
| [Objective templates](https://github.com/Hector-xue/IvyeaOps/blob/b6523be65006aa3e45ce88cdf583d93fd1d478c9/skills/amazon/amazon-ad-campaign-optimization-xlsx/references/decision_rules.md) | Different decision priorities for growth and profitability; protected-term configuration | Author preferences concerning SBV, Vine and particular placement multipliers are not global business rules; protection has budget and expiry constraints |
| [Advertising board](https://github.com/Hector-xue/IvyeaOps/blob/b6523be65006aa3e45ce88cdf583d93fd1d478c9/client/src/pages/workbench/home/AdsBoard.tsx) | Exceptions, target deviations, evidence and adjustment entry in one place | Do not add different currencies; CSV imports do not supply live hourly spend or confirmed budget exhaustion |
| [Candidate UI](https://github.com/Hector-xue/IvyeaOps/blob/b6523be65006aa3e45ce88cdf583d93fd1d478c9/client/src/pages/workbench/LingXingOptimizer.tsx) | Current/proposed values, evidence, individual and batch review | Preserve filters and selection; repeat uploads must not recreate equivalent pending actions |
| [Controlled operations](https://github.com/Hector-xue/IvyeaOps/blob/b6523be65006aa3e45ce88cdf583d93fd1d478c9/server/app/services/lingxing_operate.py) | Change limits, cooldown, original values, audit trail and failure states | AI approval is not marketplace authorization; irreversible operations cannot promise full rollback; stale evidence must be reviewed again |
| [Advisory automation](https://github.com/Hector-xue/IvyeaOps/blob/b6523be65006aa3e45ce88cdf583d93fd1d478c9/server/app/services/lingxing_automation.py) | Structured results, run history and progress | Recalculate deterministically from sealed report versions; model confidence is not a calibrated probability |
| [CSV plan](https://github.com/Hector-xue/IvyeaOps/blob/b6523be65006aa3e45ce88cdf583d93fd1d478c9/skills/amazon/amazon-ad-campaign-optimization-xlsx/SKILL.md) | Stable diagnosis/action/checklist export | Report adapters must recognize the actual headers and grain; multiple breakdowns of the same spend cannot be concatenated into totals |

One concrete upstream arithmetic issue needs a separate regression: its reduction
formula takes the minimum of the estimated ideal bid and the step-reduced bid,
which can exceed the stated maximum reduction. Our proposed bid must instead
remain inside the configured change interval. A historical CPC allowance is not
a verified base-bid ceiling when dynamic bidding and placement multipliers are
unknown.

## Import and evidence rules

- Supported report families: Campaign, Advertised product, Targeting, Search
  term, Placement, Converted product, Audience, Benchmark, Industry-standard
  delivery measurement, Search-term impression share and Top-of-search share.
- Detect families from headers. An `SP_` filename does not establish the ad
  product: Campaign may contain SP, SB and SD. Carry explicit product values or
  join a uniquely identified Campaign; otherwise retain an unknown product.
- Preserve UTF-8 CSV quoting, BOM, embedded commas/newlines, empty cells and
  original text IDs. Decode spreadsheet ID wrappers as text without evaluation.
- Daily rows, entity interval summaries and account-level share reports have
  different grains. Do not spread interval summaries across invented days.
- Monetary amounts use safe integer minor units. Missing denominators return
  null ratios. View-attributed purchases may exceed clicks; this does not justify
  rejecting Placement rows or manufacturing a click-based CVR.
- Imports retain a raw-file checksum and private source, metadata and immutable
  normalized facts. Exact replay is idempotent. Changed exports create new
  versions. Prefer the latest observation for the same fact interval; overlapping
  interval summaries are diagnosed, not added together.
- Campaign is the control grain for headline totals. Other families provide
  breakdowns and reconciliation diagnostics. Never add Campaign, Product,
  Targeting, Search term and Placement totals together.
- Currency, advertiser, marketplace, timezone, ad product and attribution basis
  remain explicit. Missing marketplace information needs an operator mapping.
- Empty benchmark percentiles do not provide peer comparisons. Industry-standard
  measurement is delivery evidence, not a category benchmark. Search share rank
  is advertising share rank, not organic search position.
- Reject malformed structure, unsafe numbers and unsafe file sizes with clear
  diagnostics; retain valid report evidence when independent rows are invalid.

## Operational views

The default view is Daily review. Additional tabs are Product goals, Search terms
and targets, Campaigns and placements, Adjustments and review, Import history,
and the existing VOC workspace. Source receipts, input grain and data freshness
are visible. Lists retain filters, page and selection through detail drawers.
Narrow screens show a compact list and full-width details.

Every recommendation includes object scope, current/proposed values, rule ID,
evidence interval, sample counts, goal revision, data maturity, change constraints,
and the next review date. States include pending, adopted, executed, observing,
reviewed, rejected, deferred and stale. Events are append-only and updates use
optimistic concurrency and idempotency keys. Equivalent pending work is deduped.

Organic-rank observations and product-period commercial evidence are separately
recorded with source and dates. Advertising attributed purchases cannot be
subtracted from total orders to assert organic orders or incrementality. Review
compares available outcomes and states coverage limitations.

## Security and verification

All reads and writes run inside `withTenant()` using the application role and
forced RLS. Existing customer-intelligence read/write/review permissions apply.
Account selection is checked against authenticated tenant ownership. Report,
goal and action identifiers cannot cross tenant boundaries. Safe exports prevent
spreadsheet formula injection and pin exact evidence and goal revisions.

Raw CSVs stay in the private `advertising` storage domain. Commit requires a
matching preview checksum and a clean ClamAV scan; unavailable scanning fails
closed. Failed or raced commits discard only their exact unreferenced uploads.
The workspace response excludes private object keys. Source downloads authorize
the import and verify its checksum. No raw report is sent to an AI provider.

## API, persistence and runtime

The real ERP page remains `/customer-intelligence`; no navigation entry is added.
Authenticated REST routes under `/v1/advertising` expose:

| Route | Purpose |
| --- | --- |
| `GET workspace`, `GET facts` | Account-scoped workbench and paginated source versions |
| `POST imports/preview`, `POST imports` | Parse/diagnose, then scan and commit the exact preview |
| `GET imports/:id/source`, `POST imports/:id/archive` | Authorized raw download and one-way archival |
| `POST goals`, `POST observations`, `POST analyses` | Revisioned objectives, qualified outcomes and sealed runs |
| `POST actions/:id/events` | Optimistic human review and actual manual-execution records |
| `POST exports`, `GET exports/:id`, `GET exports/:id/csv` | Sealed JSON package and spreadsheet-safe operator checklist |

The Web `/api/advertising/*` BFF follows the existing local OIDC service-account
development path, validates allowed routes/query/body and requires same-origin
POSTs. It returns an explicit unavailable state in production; an end-user OIDC
session BFF is a separate production integration. This does not weaken API
authentication or permit caller-selected tenant context.

Migration `0102_advertising_workbench` introduces `ad_import_batches`,
`ad_imports`, `ad_facts`, `ad_products`, `ad_goal_versions`, `ad_observations`,
`ad_analysis_runs`, `ad_actions`, `ad_action_events`, `ad_import_events` and
`ad_exports`. Follow-up migration `0103_advertising_upgrade` adds nullable import
date headers to earlier development installations and updates candidate
deduplication and action guards. It does not rewrite raw facts, history or sealed
packages. Older package payloads keep their checksum when optional source pins
or execution IDs were never recorded. All tables have forced
tenant RLS and composite tenant references. Source
facts, goals, observations, runs, exports and events prohibit update/delete;
only product revisions, one-way archive state and guarded action projections
can change. Database triggers also enforce the action transition matrix.

Apply `pnpm --filter @yummyai/database db:migrate`, then use `pnpm start:local`
to restore missing local services and `pnpm check:local-runtime`. The launcher
reuses a running API and skips migration in that case; explicitly migrate before
using an already-running development API. No new environment variables, external connector,
background worker or model configuration is required. API/Web, PostgreSQL,
private MinIO storage, OIDC and healthy ClamAV are required for commit. With
`dev:lite`, start scanning using `pnpm infra:file-scanning`.

## Operator workflow and limitations

1. Select an existing Amazon shop and preview the downloaded UTF-8 CSVs. Confirm
   their download time, report timezone, attribution basis/window and explicit
   currency-to-marketplace mapping. Unknown attribution remains unknown. Maximum
   size is 5 MiB per file, 20 files and 20 MiB per batch.
2. Check accepted/quarantined rows and diagnostics; partial import requires an
   explicit checkbox. Commit only after the preview matches these settings.
3. Set each marketplace/currency/ASIN's rank or profit objective. Define price
   and full variable cost when available; these are operator inputs rather than
   automatically reconciled settlement facts. Keep trial limits and protection
   rules explicit. Switching objectives creates a new revision.
4. Analyze a window that contains whole source intervals. Headline control totals
   separate currencies and measurement scopes. Source-detail lists deliberately
   show dated raw versions for inspection; they are not summed analysis facts.
5. Read the candidate's evidence and constraints. Adopt/reject/defer it. After
   carrying out an approved operation in the seller tool, record actual IDs,
   before/after values and execution time. Then observe and review after the
   configured cooldown. Follow-up conclusions are operator-recorded and must
   identify the new report evidence; passing a sample threshold is not proof of
   statistical significance or incremental lift.
6. Seal selected reviewed actions. JSON pins the analysis, source receipts,
   goal/evidence snapshots, actual destination IDs and event history with a
   checksum. CSV is a human checklist, not an Amazon bulk-upload command. Later
   state changes never rewrite the package.

Natural-rank observations require an actual source, keyword and observation day.
The core-term view compares recorded positions after the objective's effective
date; it does not prove advertising caused the movement. TACoS and post-ad
contribution need matching commercial evidence and explicit confirmation that
the product's ad-spend coverage is complete. Competing advertiser/measurement
scopes keep these outputs unavailable. Total orders minus attributed ad orders
is never presented as organic orders.

Current deterministic optimization rules cover identifiable SP objects. SB, SD,
ambiguous multi-ASIN groups and unknown identities remain visible for review;
they do not receive an invented bid/negative action. Historical CSV bids are not
live settings. Budget exhaustion, hourly spend, dynamic bidding and placement
multipliers cannot be confirmed from these exports. Empty benchmark percentiles
remain unavailable. Missing daily grain means no daily trend.

Equivalent requests and candidate keys are deduplicated. New imports, relevant
goal revisions, observations or archival expire unexecuted candidates. Re-run
analysis before adopting them. An archived report leaves immutable historical
analysis and raw receipts intact. Restoring an archive is not supported; import
a legitimately new source version if needed. Workspace responses cap recent
imports/runs and candidate generation; diagnostics request narrower scope when
limits are reached.

## Verification and cleanup

Acceptance requires parser/metric regressions, forced-RLS isolation, immutable
histories, replay/conflict, bounded actual execution, cooldown and post-cooldown
review, and rendered desktop/390 px browser evidence with DEMO flags disabled.
The API integration suite also includes the existing VOC regression suite.

```powershell
pnpm test:e2e:order-daily --suite=advertising-integration
pnpm test:e2e:order-daily --suite=advertising
```

The owned runner creates a disposable database, private bucket and Redis, and
removes them in `finally`. It records exact resource IDs and verified cleanup
under ignored `tmp/order-daily-e2e-*.json`; screenshots and fixture IDs are under
`tmp/advertising-e2e`. Stop the workspace Next dev server before browser tests or
build and restore using `pnpm start:local`. Do not run integration tests against
real business resources. See the [evidence ledger](../superpowers/plans/2026-10-08-advertising-workbench.md)
for current commands and outcomes. This feature verification is not a release
candidate, clean-commit CI result or provider-write acceptance.
