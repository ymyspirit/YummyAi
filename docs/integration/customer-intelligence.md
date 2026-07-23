# Customer intelligence integration

Authenticated routes are rooted at `/v1/customer-intelligence`.

- `GET /workspace` requires `customer_intelligence:read`.
- `POST /advertising-reports` and `POST /signals` require `customer_intelligence:write`.
- `POST /definitions`, `POST /analyses`, and `POST /recommendations/:id/review` require `customer_intelligence:review`.

Advertising reports must provide a stable external report ID, source currency, attribution window, observed time, and unique metric line keys. Customer signals must set `identityRedacted: true`, name an allowed consent basis, include only a checksum of any excerpt, and reference existing tenant evidence. Reusing an idempotency key with changed content returns a conflict.

Analysis output is review-only. Consumers must not treat an approved recommendation as a Listing edit, campaign mutation, budget change, product change, or customer-service action. Such changes belong to separately authorized domain commands. Provider advertising retrieval remains an online acceptance gate and must use supported authorization; manual reports are evidence imports, not simulated provider data.
