# Order center grouped product review

Implemented on the formal `/orders` route on 2026-09-14.

- Orders group their matching product lines; grouped pagination does not split an order's matching lines.
- Pending-review products support item/group/page selection and explicit selection of all filtered results, capped at 100 products per batch. Page changes retain selection; changing filters clears it.
- Rows show sales SKU, print SKU, SPU/specification, buyer customization, authorized previews, workflow status, quantity and internal deadline.
- Inline editing reuses the existing versioned editor. Continuous review and cross-center return context remain available.
- Batch preview uses the normal save validators, with fill-empty-only enabled by default. Execution retains exact per-product versions and retry keys; completed selections are removed and failed/blocked selections remain.
- Batch AI displays the selected model and maximum cost, submits products sequentially, and stops subsequent submissions after failure or cancellation. Suggestions require individual adoption.

## Validation

- Full `pnpm test` passed (including rules, tooling and workspace unit suites).
- Full `pnpm typecheck` passed; Web typecheck was also rerun after the bulk-preview changes.
- Order workspace integration: 6 passed, including grouped paging, tenant isolation, protected summaries, preview without mutation, preserved customization and changed projection rejection.
- Amazon report integration: 22 passed, including private file access, source changes, reimports and retention.
- Browser regression: 20 passed across order review, processing and the original four rich-list scenarios. The updated rich-list suite then passed all 5 scenarios, adding configured AI failure handling through a synthetic transport. Total distinct browser scenarios: 21.
- Full `pnpm build` passed; the Web build was rerun after the final bulk-preview refinement.
- Modified-file ESLint passed. Full lint reported an unrelated unused `and` import in `apps/api/src/ai/model-configuration.service.ts:8`.
- Browser screenshots inspected at 1440px and 390px. Existing live imported orders displayed their real customization fields and preview images; pending-review checkboxes were enabled. No real order was saved or pushed and no external AI channel was invoked during verification.

Browser fixture artifacts are under `tmp/workflow-navigation/test-results/`. The fixtures own their in-memory transport; API integration tests own isolated synthetic tenants.

See [order centers integration](../integration/order-centers.md) and the [user guide](../user-guide.md) for the workflow and endpoint contracts. This is feature validation, not a release-candidate or marketplace-publishing approval.
