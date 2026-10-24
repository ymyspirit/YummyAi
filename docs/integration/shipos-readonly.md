# ShipOS connection and existing-order sync

## Observation ordering and shipment transaction

Migration 0137 introduces a connection-local `bigint` sync sequence, reserved atomically with each new admitted request under the existing tenant/supplier advisory lock. Configuration `version` still describes configuration only. Replays retain their original request, sequence and snapshots; they do not reserve again or query the vendor again. Newly sequenced observations take precedence over legacy unsequenced records, independent of wall-clock time or UUID order. Stored timestamps remain original evidence and do not grant logical ordering authority.

Existing runs keep NULL sequences. They are never numbered from timestamps, IDs or assumed commit order. Existing history and already pinned shipment sources remain unchanged; selecting an unsequenced source for a new package returns an explicit resync requirement. The cached order-evidence response includes that blocker. After an authorized normal read creates a new observation, the operator can select that record through the normal flow.

Pinning holds a connection `FOR SHARE` lock through the caller's shipment transaction. Admission updates the counter and result commit takes `FOR NO KEY UPDATE`, so neither can race past a validated pin. Since whole-order shipping already locks its order header, pin takes the connection lock with NOWAIT and maps contention to a retryable conflict; it does not wait in the reverse order against the sync snapshot's order foreign key. Tenant RLS, current permissions, expected configuration version, current retained order, tracking and channel-mapping checks remain mandatory.

The implementation reuses [PostgreSQL row locks](https://www.postgresql.org/docs/current/explicit-locking.html) and [Drizzle bigint mapping](https://orm.drizzle.team/docs/column-types#bigint). Sequences stay internal and do not leak BigInt values into existing JSON responses. The migration and three controlled concurrent transactions have isolated evidence; ordinary adoption, browser compatibility and final full validation are tracked in [the current progress record](../project-control/SHIPOS_OBSERVATION_PROGRESS_20261020.md).

## Bring an existing waybill into one order package

In whole-order shipping, the operator selects cached evidence already matched to
the same retained local order. `GET /v1/order-centers/orders/:id/shipos-evidence`
does not query ShipOS. Selection fills the tracking number and any saved channel
mapping; unmapped carrier fields remain explicit manual entries. The operator
checks the parcel information before saving all pillows into one package.

Channel mappings are optional connection configuration: exact returned channel
name, carrier code/name/service and actual ship-from country. They are not inferred
from tracking prefixes. Saving them increments the connection revision and
preserves credentials when omitted. Migration 0100 adds `channel_mappings` and
the nullable immutable shipment-version `shipos_source` pin; older connections
default to no mappings and older shipment versions keep a null source.

The shipment service delegates evidence validation to ShiposService inside the
tenant shipment transaction. It rechecks the supplier, latest snapshot ID, local
order association, retention, connection revision/status, tracking number,
cancel/refund markers and configured carrier values. No gateway method is called
when creating the local package. A changed source requires refresh and explicit
selection. Manual corrections can explicitly remove the source. Revised manual
shipment versions do not inherit a previous source claim.

The order displays the saved source timestamp and an authenticated link to the
existing label. Label reads also reject a current vendor tracking number that
differs from the saved snapshot. No label is issued, purchased or regenerated.
Saving or approving a package and vendor shipping status never establish actual
physical handover; the ordinary handover evidence still controls 出库.

## Operator workflow

Connection configuration is maintained under **供应商档案 → supplier detail →
ShipOS 连接配置**. Daily work is under **订单与履约 → 发货中心 → 物流订单同步**
(`/shipments?view=logistics`). Select a supplier's connection to view its records;
links between the two pages preserve that supplier selection. The supplier owns
one connection and its factories can share the same logistics account. This
connection does not select a factory or change any production destination.
The fulfillment page never renders credential inputs; the supplier page does
not render order-number entry, sync results or label download operations.
Both use the same existing authenticated service and immutable sync history.

1. Save a connection draft with a name. Credentials can be added later.
2. Enter the existing ShipOS AppKey and AppSecret together, save, then **测试连接**.
   The test reads the module-2 channel list. An empty list is a successful query,
   not evidence that shipping channels have been configured.
3. Select **启用**, save, then **前往物流订单同步**. Enter existing ShipOS order numbers. Up to 50 numbers
   are accepted by the UI, in sequential batches of at most five. **停止后续批次**
   stops between batches; the current query may finish.
4. Inspect tracking, existing-label availability, external status, explicit fee
   and currency, local association and diagnostics. Match requires exactly one
   local order with the same external order number in this tenant and a retained
   encrypted order source. Missing orders and duplicate numbers across stores remain
   unassociated. Import/correct the local order through its normal workflow,
   then sync again; this feature never creates a local marketplace order.
5. **下载现有面单** is available only for a matched retained order. It fetches the
   current detail, reads its existing PDF, then rechecks local retention and
   connection version before returning a private authenticated attachment.

Pause a connection to block further remote reads. Switching to draft/paused and
checking **清除凭据** removes the encrypted credential envelope. Blank credential
inputs preserve the existing pair; credentials are never returned to the browser.
Use **管理连接配置** from fulfillment to make these changes in the supplier profile.
Neither a successful connection test nor label availability proves factory
acceptance, physical handover, production completion or successful marketplace
fulfillment. Continue those workflows through their normal reviewed actions.

## Fixed vendor boundary

The server fixes the API host to `https://api.shipos.cn`. Authentication uses
`appkey` / `appsecret` headers. The only allowed outbound API paths are:

| Purpose | Path | Body |
| --- | --- | --- |
| Connection test | `/api/getChannel.php` | `{ "module": 2 }` |
| Specific existing orders | `/api/queryOrder.php` | `{ "mkid": 2, "orderid": "ID1,ID2" }` |
| Existing order details | `/api/orderDetail.php` | `{ "orderid": "ID1" }` |

Vendor references: [channels](https://s.apifox.cn/45f68512-0e9b-41e9-8bd5-d8498f6faccd/api-109219530),
[order status](https://s.apifox.cn/45f68512-0e9b-41e9-8bd5-d8498f6faccd/api-227863272),
[order detail](https://s.apifox.cn/45f68512-0e9b-41e9-8bd5-d8498f6faccd/api-296907435).
These pages were checked in the logged-in supplier workflow on 2026-10-06.
The detail API is marked under development; a failure retains the status-query
evidence and reports `detail_unavailable`. Fees are populated only from an
explicit `fee_data.currency` plus valid `total_fee`; missing values stay null.
Detail identity must agree with both the requested order number and module 2.

There is no arbitrary action, URL, host or path forwarding. Creation, issuance,
`getLabels.php`, cancellation, refunds, scan forms, accessory uploads, platform
writeback and whole-account list scans are excluded. This deliberately avoids
any endpoint that can create or advance a chargeable operation. The unconfirmed
`getTracks.php` request format is not implemented; the current module syncs
order status and tracking numbers, not a full carrier-event history.

Existing label sources must be HTTPS PDFs under
`shipease.oss-cn-hangzhou.aliyuncs.com/pdfs/`, without URL userinfo or fragments.
Redirects are refused. Vendor credentials are not sent to the PDF host. An
unknown label host is treated as unavailable until verified and explicitly
allowed in code. PDF downloads are limited to 10 MiB and checked for PDF magic.
API bodies are limited to 1 MiB with a 10-second request timeout; no raw vendor
response or buyer address/name/phone/email is persisted or logged.

## REST, permissions and storage

All endpoints derive tenant membership from normal application authentication.
The Web proxy at `/api/shipos/[...path]` allows only the routes below, same-origin
JSON writes, no query overrides, and at most 16 KiB request bodies.

| API route under `/v1/sourcing/suppliers/:supplier/shipos` | Method | Permissions |
| --- | --- | --- |
| Workspace | GET | `OrderRead`, tenant data scope |
| `/connection` | POST | `OrderRead`, `IntegrationManage` |
| `/test` | POST | `OrderRead`, `IntegrationManage` |
| `/sync` | POST | `OrderRead`, `IntegrationManage`, `OrderWrite`, `OrderPiiRead` |
| `/records/:record/label` | GET | `OrderRead`, `OrderPiiRead` |

Migration `0095_shipos_readonly` adds three tenant tables with forced RLS and
grants to `yummyai_app` only: `shipos_connections`, `shipos_sync_runs` and
`shipos_order_snapshots`. Credentials use `INTEGRATION_SECRET_ENCRYPTION_KEY`
through the existing dedicated integration vault. Production requires its own
32-byte base64url key. Local development uses the existing integration-domain
fallback documented for the vault; no ShipOS credential environment variable is
introduced. Connection edits require expected versions; paired replacement
resets the last connection-test result.

Snapshots are immutable, contain only approved external business metadata and
local references, and do not store PDF URLs or buyer payloads. Sync run pins the
connection version. Identical idempotency keys replay the original run; changed
payloads conflict. A connection has at most one active sync. Failed queries are
recorded without vendor messages. If the process stops before completion, a
workspace read/new sync marks runs older than 90 seconds interrupted; retry with
a fresh command after inspecting history. A changed/paused connection discards
in-flight query results. No business worker or paid provider is started for this
bounded synchronous module.

## Isolated verification and cleanup

The ShipOS browser suite now uses the existing personal OIDC/BFF fixture on
API 8130 and Web 3130. Select an already verified compiled candidate with
`--compiled-web --candidate=<ID>`; the ordinary API/Web remain running on
8000/3000, and no ordinary account is used. Development-server suites still
require stopping a Next.js dev server that owns the same worktree dev lock.
Use a fresh owned `YUMMYAI_TEST_CACHE_DIR` with `TSX_DISABLE_CACHE=1`.

`pnpm test:e2e:order-daily --suite=shipos-integration` runs the 11 service
checks; `--suite=shipos-upgrade-integration` starts a genuine pre-0137 schema
and tests the 136-to-137 upgrade. The root `pnpm test:integration` includes
that separate historical child and requires all seven children to succeed.
For the existing browser scenario, use `--suite=shipos --compiled-web
--candidate=<ID>` with an available verified candidate.

The runner creates an exact disposable `order_daily_e2e_<32hex>` database,
matching private bucket and dedicated Redis container. A loopback query-only
fake ShipOS is used for E2E and service mocks for integration. Exact teardown
runs in `finally`, including failed assertions. The runner writes owned output
explicitly and records resource names in `tmp/order-daily-e2e-<token>.json`.
`tmp/shipos-query-proof-<token>.json` records endpoint counts only; forbidden
requests must be zero. Inspect desktop/mobile screenshots and reports, retain
concise conclusions in the checkpoint, then remove the raw screenshots, logs,
traces, downloads, caches and their exact owned manifests/proofs. Historical
frozen output is not retried; private real-business backups are retained.

The browser scenario verifies personal OIDC/BFF, configuration-only and sync-only
controls, supplier switching without record leakage, order association,
existing-label download and pause behavior at 1440/390 widths. A successful
identity-only suite must never be reported as ShipOS browser acceptance.

`SHIPOS_TEST_BASE_URL` is a runner-only loopback endpoint. It is rejected in
production and requires `E2E_ISOLATED_DAILY=1` plus the exact disposable database
name. Never put it into the user's `.env` or runtime startup commands. Restart
the normal API/Web after migrations using the local-development runbook.
