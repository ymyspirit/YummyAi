# Order center startup performance

The order center loads the native list and options in parallel, then reads the current page's private customization summaries. The list can render before those summaries are available; editing and bulk actions still require current readable source evidence.

## Read path

- A list request materializes the tenant-authorized work projection once. Matching totals, grouped pagination, queue counts, operator views and whole-order lifecycle counts share it while retaining their distinct filter scopes. Whole-order state is computed before item filtering. The final JSON aggregation preserves the original explicit row order.
- Summary discovery reads only the requested work/source headers. It does not calculate the complete production, shipment and quality projection for every tenant order.
- Summary source checks read report/version/privacy headers in batches. PostgreSQL computes SHA-256 for retained source, document, archive and address-envelope ciphertext; those large private values do not cross the database boundary on the normal saved-metadata path. This remains request-local evidence, never a shared private-content cache.
- Current tenant membership, permissions, original report/version ownership, retention, source pins and per-item parse failure isolation remain mandatory. Legacy records without a saved read model use the existing original-version derivation path. Cleared private content is never rebuilt from a different source.
- The final coordinator holds the original source locks, rechecks current authority and uses a fresh database clock against work, privacy, report and pinned-version deadlines before returning any private summary.
- Order drawers, inline editors and bulk panels use conditional `next/dynamic` imports. The existing edit guards and transitions remain in their owning components. Summary request cancellation is forwarded through the BFF; business action requests retain their original completion/recovery behavior.

## Regression and measurement

Run native checks through the disposable acceptance runner. The summary suite includes the original availability tests and a batch-performance regression using actual imported, encrypted synthetic reports. Driver observers record counts and byte totals only, never SQL parameters or private bodies.

```text
pnpm test:e2e:order-daily --suite=order-summary-availability-integration --cache=false
pnpm test:e2e:order-daily --suite=order-operations-integration --cache=false
```

The batch regression compares one row with twelve independent orders. Tenant transactions and version reads must remain bounded, retained large ciphertext must not be returned, and every readable item must retain its exact original source. Separate cases cover corrupt metadata beside healthy peers, actual expiry, late anonymization/purge and revoked PII permission. Expired/purged fixture content cannot be made readable by restoring its old timestamp.

For browser measurements, separate document/navigation, list completion and private-summary completion. Reuse the same authorized session, filters and source data for repeated warm reloads; report the sample count and median/range rather than an unsupported percentile. A list loading flag alone does not prove private summaries are ready. Compiled browser checks must use the exact verified candidate and disposable database, bucket, Redis and identity lifecycle.

On 2026-10-30 the adopted schema-193 runtime was measured before this change with 20 orders, 25 product rows and 30 units. Three warm reloads had median workspace response 1,407 ms, summary response 19,418 ms, and navigation-to-summary response completion 21,325 ms. These are baseline observations, not a claim that this change has been deployed or that a particular speedup is guaranteed. Candidate and adopted-runtime results belong to the release checkpoint.

The implementation reuses [Next.js lazy loading](https://nextjs.org/docs/app/guides/lazy-loading) and [PostgreSQL materialized CTEs](https://www.postgresql.org/docs/current/queries-with.html); no new query framework, dependency, database migration or model call is required.
