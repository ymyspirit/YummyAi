# AI settings workflow

The native `/settings/ai` workbench is the primary configuration surface. It
reuses `/v1/ai/configuration`, the encrypted provider vault and the existing
tenant transaction boundary. The vendored Infinite Canvas settings remain a
collapsed advanced compatibility surface; no provider credentials move into
browser storage or vendor code.

## Operator flow

1. **渠道连接** adds or edits a connection. Model discovery performs the existing
   bounded provider-directory read, then offers search and selection. A blank
   credential on an existing connection retains its encrypted secret.
2. **模型库** lists shared creative routes and legacy analysis routes. Search,
   configured purpose, connection and status filters do not imply capability
   verification. Rename, reversible pause, resume and removal are separate
   operations. No inference request starts from a configuration read or save.
3. **业务默认** saves personal general defaults separately from personal purpose
   defaults. New order analysis, artwork preflight and Agent chat can prefer
   different routes. Existing operator selections and immutable manufacturing
   or execution snapshots take precedence over suggestions for new tasks.
4. **用量与费用** embeds the existing billing workbench. Official reference
   calculations, configured estimates and provider reconciliation remain
   distinct. Unknown usage or prices remain unknown; explicit zero is free.

The `settingsTab` query parameter accepts only `channels`, `models`, `defaults`
or `usage`. Existing return context and billing selection parameters survive
tab changes. The old `#analysis-model-settings` link opens the native model
library. Compatibility forms remain available under **高级兼容配置**.

## Shared transport

All writes retain the existing tenant configuration advisory lock, current
membership checks and revision fence. New operations are:

- `purpose-defaults.save`: `{ revision, defaults }`, where the strict optional
  keys are the supported assistant purposes plus `agent_chat`. This updates the
  caller's existing `model_preferences.defaults.purposeDefaults` JSON only.
- `model.status`: `{ channelId, modelId, revision, status }` for a reversible
  configuration pause or resume.
- `model.update`: `{ channelId, modelId, revision, label }` for a display label.
- `model.analysis-pricing.save`: `{ channelId, modelId, revision, pricing }`.
  Input/output prices and `maxTaskCostUsd` are nullable. A positive hard cap
  requires both prices. New analysis registrations default to unknown prices
  and no per-model task cap; organization policies and execution admission
  remain independently enforced.

No SQL migration is needed. Existing four-field `defaults.save` clients preserve
the optional purpose map when they omit it. Runtime `AssistModel.defaultFor`
contains only current personal preference metadata for visible enabled routes.
It is stripped before execution/price identity comparison and snapshot creation.

## Pauses, prices and history

Reversible pauses use route status `disabled` plus the optional target marker
`configurationDisabled`. Historical removals have no such marker and remain
absent from the editable catalogue. Legacy channel saves preserve paused route
state; the compatibility picker omits paused routes. The old analysis-create
endpoint cannot silently restore or move a paused model under another provider.

An explicitly paused legacy analysis route can still supply an existing quote
or cap inherited by a shared text alias. The public configuration projects that
effective price and `analysisPricingInheritedFrom`; it does not advertise an
unlimited route while execution still inherits a cap. Conflicting same-pair
price changes direct the operator to the source analysis route. Price updates
check active aliases as well as the edited route.

Busy protection includes queued/running assistant and Studio requests and
queued/running/stopping loop/plan/native parent tasks. Pausing a selectable
route does not manufacture cancellation, delete receipts or rewrite old usage,
pricing snapshots, reconciliation history or personal preferences of other
members. Unknown write outcomes require reading the latest configuration;
the UI does not automatically repeat the mutation.

The official price catalogue is a read-only reuse of the existing published
reference. Applying a matched rate as an estimate is an explicit action. An
unmatched model remains **待核价**; an official reference is not a provider's
actual invoice. Existing request snapshots and immutable reconciliation records
remain the evidence for past configured costs.

## Validation boundary

The `model-configuration-integration` disposable suite includes the original
configuration tests and dedicated native settings tests. Compiled personal
browser acceptance retains the original seven configuration regressions,
content-authorization and SPU checks, then adds the native settings workflow at
desktop and mobile widths. Provider discovery and configuration HTTP fixtures
are synthetic in these browser cases; authentication and application rendering
use the actual personal path. They do not prove a real model's image, streaming
or tool capabilities and invoke no paid models.
