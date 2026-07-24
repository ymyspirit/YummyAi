# Channel inventory integration

P3-C separates network inventory evidence from P3-A inventory movements and
turns the latest eligible evidence into versioned channel availability
projections. It does not infer provider quantities or authorize a marketplace
account.

## Normalized provider boundary

`@yummyai/marketplace-connectors` exposes `MarketplaceInventoryConnector`,
`ProviderInventoryReportSchema`, and `normalizeProviderInventoryReport`.
Connector implementations return provider records and a monotonic checkpoint;
normalization maps them to:

- source: `owned`, `fba`, `fbm`, `overseas_3pl`, `supplier`, `in_transit`, or
  `virtual`;
- condition: `sellable`, `quarantine`, or `damaged`;
- external SKU, integer quantity, optional warehouse code, observed time, and
  provider snapshot ID.

The authenticated caller resolves external SKU and warehouse references to
tenant stock-item/location IDs before submitting a snapshot. Amazon/Etsy
snapshots require an account of the matching platform. A provider scope cannot
reuse or regress its checkpoint sequence.

## API

| Method | Route | Permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/v1/channel-inventory/workspace` | `channel_inventory:read` | Read safe stock references, snapshots, current policies, recent runs, projections, and reconciliation state |
| `POST` | `/v1/channel-inventory/snapshots` | `channel_inventory:write` | Append normalized network inventory evidence and checkpoint |
| `POST` | `/v1/channel-inventory/allocation-policies` | `channel_inventory:write` | Create a policy or append a new immutable version |
| `POST` | `/v1/channel-inventory/allocation-runs` | `channel_inventory:write` | Calculate immutable per-channel projections from current evidence |
| `POST` | `/v1/channel-inventory/reconciliations` | `channel_inventory:write` | Open an uncertain external-mutation reconciliation |
| `POST` | `/v1/channel-inventory/reconciliations/:id/resolve` | `channel_inventory:reconcile` | Append a confirmed or rejected resolution |

The workspace omits tenant IDs, user IDs, idempotency keys, raw provider
payloads, and credentials.

## Allocation rules

Only `sellable` lines from the policy's eligible sources participate. Virtual
stock additionally requires `allowVirtual=true`. The calculation is:

1. Select the latest snapshot for every provider/scope.
2. Sum eligible lines for the stock item.
3. Subtract the policy safety buffer, never below zero.
4. Process channel targets by priority.
5. Consume at most the channel cap, then withhold its channel buffer.

Total published allocation cannot exceed the post-safety-buffer quantity.
Quarantine and damaged stock never participate. In-transit, supplier, and
virtual stock participate only when the policy explicitly names the source.

## Listing write guard and reconciliation

`push_price_inventory` and `push_full_content` derive each marketplace SKU from the approved pinned
Listing payload and resolves it through catalog SKU to inventory stock item.
Each SKU requires a projection for the same account, platform, marketplace, and
Listing (or a policy wildcard). Missing policy, missing current-version run,
newer inventory evidence, missing target, or excess quantity blocks the command.
A caller cannot supply its own allocation limit.

The Worker records `processing` before the provider mutation. If execution is
interrupted or the connector reports an uncertain outcome, the sync becomes
`reconciliation_required` and an open channel reconciliation is appended.
Automatic mutation retry is disabled until provider state is read and an
operator appends a resolution.
