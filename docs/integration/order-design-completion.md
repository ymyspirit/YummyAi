# Order design method and original completion

2026-10-18 · PRD 1.1 · R04/R20/R22/R39 · B14/B28. Reuses the existing
order-design repository, bounded executor, budget ledger, response recovery,
HarnessRegistry and knowledge owner. It adds no second workflow engine.
Local verification and real business acceptance remain separate.

## Published methods and original input

The code-owned catalog adds `order.design.template` and
`order.design.pillow_photo`, version `order-design-method-2026-10-18-v1`.
Their tool descriptors retain the existing six order/design/asset permissions,
original work revision, fixed recipe and model route, call limits and budget.
The existing image-enhancement policy and instruction digest participates in
the contract; reviewed method notes cannot change those instructions or
manufacturing values. Published knowledge is procedure provenance and remains
in the source-data domain.

Registration selects the original published method in the same transaction as
the original task. `method_snapshot` pins its supported code contract, publication,
withdrawal generation and knowledge sources. New inputs bind snapshot and method
with a canonical checksum that survives JSONB object-key ordering. Genuine legacy
NULL snapshots retain their former JSON checksum and are never backfilled.
After tenant adoption, a missing legacy selection cannot bypass that governance.

The executor checks current membership, original business source, supported method,
publication generation and knowledge validity at admission, step claim, provider
submission and result adoption. A newer publication does not replace an otherwise
valid original version. Disable/re-enable does not revive an old generation.
An unsubmitted task stopped by temporary read-permission loss may resume its
original plan after access is restored; unsupported/withdrawn methods still stop.

## Capture and recovery

An already-submitted original response is captured under its original running
token/request, retention, source and encryption guards even if the member or
method loses execution authority while the provider is returning. Store the
encrypted receipt/checkpoint and any provider-reported fee before checking
whether the image can be adopted. A fee report is distinct from a verified bill.
No response adoption or next paid step is permitted without current authority.
Restoring access reuses the original valid response rather than buying it again.
Unknown submission and unavailable checkpoints retain their existing explicit
reconciliation boundaries. Privacy expiry/destruction does not authorize recovery
or disclosure. Original submission and minimal fee receipts now persist separately
from private response capture; a genuine late report can settle its original
budget after key destruction without retaining or adopting the image. Eight-place
reports, six-place budget occupancy, current private/financial read boundaries and
the migration/verification limits are specified in
[original calls and fees](order-design-model-costs.md).

## Original technical handoff

`OrderDesignCompletionV1Schema` lives in
`@yummyai/contracts/order/design-harness`, independently of the screen DTO.
At the final `review_required` step, the existing owning transaction seals:

- Original run/work/revision, fixed input and method contract checksums.
- Actual private project/editor version, document/template/rule/quality checksums.
- Every original completed step, input/request identity and actual output references.
- Original full-resolution proof renders, encrypted-manifest checksums, file byte
  sizes and plaintext SHA-256 checksums.
- `resultState=awaiting_review`, `requiresBusinessReview=true` and
  `automaticProductionApproval=false`.

Proof creation reads the stored encrypted file back and checks its decrypted
bytes before committing a render. Downloads with a recorded checksum recheck
the actual bytes and size. Historical manifests without this field retain their
legacy behavior and are not relabelled as verified original handoffs.
The completion checksum and identity are verified on read. Later manual changes
do not rewrite this original handoff into the current production result.

Migration `0123_order_design_methods_completion.sql` adds nullable paired evidence,
requires it for native awaiting-review runs, validates actual original step/proof
and private unreviewed version references, and protects original input, completed
step output and referenced proof metadata. The migration does not create missing
historical completion. It has only been exercised in disposable databases;
ordinary development/business databases are not migrated by this change.

## Read behavior and review

Published method history additionally requires current `workflow:read`. The order
detail shows the original method, a link to its exact history, and the count of
verified private proofs for business review. Terminal records refresh every
30 seconds and on focus/visibility; older successful reads cannot overwrite a
newer denial. Failed reads clear method/handoff details. Expired private sources
hide those details and are identified explicitly.

The financial representation omits private histories and does not decrypt order
snapshots. When the private detail is unavailable, the artwork drawer can show
this read-only status and fee evidence to a currently authorized order reader.
Current order/PII permissions still apply; revocation clears the fee panel too.

Technical completion does not mark visual review, buyer confirmation, factory
acceptance or production release. Existing supplier-specific checks and human
gates continue to apply. See [order design](order-design-agent.md),
[rule snapshots](rule-center.md) and
[factory production workflow](../operations/custom-pillow-workflow.md).

## Verification sources

- `packages/order-design/src/harness.test.ts`: contract and legacy checksum boundaries.
- `apps/api/src/orders/order-design-agent.integration.test.ts`: publication changes,
  withdrawal, original knowledge, current permissions, response/cost reuse, legacy
  absence, immutable history and actual proof-file integrity.
- `apps/web/e2e/design-agent.spec.ts`: actual order dispatch, original method history,
  unapproved proof download, desktop/mobile rendering and late-response revocation.

All use synthetic orders/assets and isolated disposable resources. No real model
quality, paid provider billing, factory acceptance or full-platform completion
is asserted by these checks. Final results are recorded in the slice delivery
report rather than inferred from the presence of these files.
