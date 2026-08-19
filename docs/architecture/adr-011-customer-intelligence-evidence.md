# ADR-011: Customer intelligence evidence and review boundary

**Status:** Accepted

P3-F stores advertising reports, metric lines, and identity-redacted customer signal facts as append-only tenant evidence. Advertising rows retain source currency and attribution window. A signal is accepted only when its source identifier exists in the tenant's capture, after-sales, support, quality, or advertising evidence.

VOC definitions create immutable versions. Each analysis pins one definition version, a time window, an evidence cutoff, and the exact signal identifiers included. Theme metrics and recommendations are immutable analytical output. A recommendation has a narrowly mutable review projection plus an append-only review event; approval does not mutate Listings, advertising budgets, products, service cases, or campaign state.

Raw customer identity, support text, provider payloads, credentials, and unrestricted excerpts are excluded. Safe views expose structured theme, sentiment, count, consent basis, and checksums only. All tables use forced RLS, composite tenant references, and least-privilege application grants.
