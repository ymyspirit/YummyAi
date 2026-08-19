# Forecasting, operating cockpit, and open integrations

## Authentication and permissions

Human and service-account requests continue to use OIDC. Tenant administrators
may create a scoped API client with `integration:manage`; its bearer token is
shown only in the creation response:

```http
Authorization: Bearer yai_<client-uuid>.<secret>
```

API client tokens contain no caller-selected tenant. The client record resolves
tenant context and contributes only its stored read scopes. Supported client
scopes are `forecast:read`, `operations:read`, `inventory:read`, `finance:read`,
`customer_intelligence:read`, `supplier_performance:read`, `order:read`,
`product:read`, and `listing:read`. Wrong, expired, or revoked tokens return
`401`. A valid token without a route's permission returns `403`.

## Planning API

| Method | Route | Permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/v1/planning/workspace` | `operations:read` | Forecasts, definitions, current projections, reconciliation queue, rebuild evidence |
| `POST` | `/v1/planning/forecasts` | `forecast:write` | Create an immutable pinned forecast run |
| `POST` | `/v1/planning/forecasts/:runId/evaluations` | `forecast:review` | Append actual-evidence accuracy metrics |
| `POST` | `/v1/planning/forecasts/:runId/overrides` | `forecast:review` | Append an optimistic override version |
| `POST` | `/v1/planning/metric-definitions` | `operations:write` | Create or version an operating metric definition |
| `POST` | `/v1/planning/metric-snapshots` | `operations:write` | Record an immutable metric snapshot |
| `POST` | `/v1/planning/reconciliations` | `operations:reconcile` | Open an explicit reconciliation item |
| `POST` | `/v1/planning/reconciliations/:id/resolve` | `operations:reconcile` | Append a resolution or dismissal event |
| `POST` | `/v1/planning/projections/rebuild` | `operations:reconcile` | Rebuild current pointers and record checksums |

Forecast creation accepts only evidence matching its metric: order events for
sales units, inventory movements for available inventory, and profit runs for
profit. Input periods must be ascending and inside the pinned window. Quantiles
must be unique, ascending, and include P50. Reusing an idempotency key with
changed input returns `409`.

The built-in deterministic model identifiers are `moving_average_v1` and
`seasonal_naive_v1`. Model output is analytical evidence only. Consumers must
not treat a forecast or override as an inventory, purchase, pricing, or Listing
command.

## Open integration API

| Method | Route | Permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/v1/integrations/workspace` | `integration:read` | Safe clients, endpoints, events, deliveries, attempts, and retention runs |
| `POST` | `/v1/integrations/api-clients` | `integration:manage` | Create a least-privilege client and one-time bearer token |
| `POST` | `/v1/integrations/api-clients/:id/revoke` | `integration:manage` | Revoke a current client |
| `POST` | `/v1/integrations/webhook-endpoints` | `integration:manage` | Create an HTTPS endpoint and one-time signing secret |
| `PATCH` | `/v1/integrations/webhook-endpoints/:id` | `integration:manage` | Optimistically update status, URL, events, and retry budget |
| `POST` | `/v1/integrations/webhook-endpoints/:id/rotate-secret` | `integration:manage` | Rotate and return a one-time signing secret |
| `POST` | `/v1/integrations/webhook-events` | `integration:manage` | Publish an allowlisted immutable event |
| `POST` | `/v1/integrations/webhook-deliveries/:id/replay` | `integration:manage` | Create a linked manual replay from a dead letter |
| `POST` | `/v1/integrations/retention-runs` | `integration:manage` | Redact event payloads before a cutoff |

Current event types are `forecast.completed`, `forecast.overridden`,
`operating.reconciliation.opened`, `operating.reconciliation.resolved`, and
`webhook.test`.

## Signature verification

The request body is canonical JSON. Verify the hexadecimal HMAC-SHA256 signature
using the endpoint signing secret:

```text
signed = X-YummyAI-Timestamp + "." + X-YummyAI-Event-Id + "." + rawRequestBody
expected = HMAC-SHA256(signingSecret, signed)
header = "v1=" + hex(expected)
```

Compare signatures in constant time, reject timestamps outside the consumer's
replay window, and deduplicate accepted events by `X-YummyAI-Event-Id`. Verify
against the raw request bytes before parsing JSON. A successful consumer returns
any 2xx status. Do not return secrets or sensitive response bodies; YummyAI
stores only status and normalized failure codes.

## Delivery and retention behavior

- `408`, `425`, `429`, `5xx`, and network failures use bounded retry and then
  enter `dead_letter`.
- Other `4xx` statuses are terminal and enter `dead_letter` without blind retry.
- If a publisher loses its response, retry the exact event with the same
  idempotency key. Existing `pending` deliveries are resubmitted with their
  deterministic delivery job IDs; changed content returns `409`.
- Manual replay creates a new delivery with `replayOfDeliveryId`; the original
  remains immutable.
- Payload retention sets the stored body to `null` but preserves its checksum,
  event identity, delivery attempts, and audit history.
- A redacted event cannot be replayed because the exact signed body is no longer
  available.

The Web workspace at `/operating-cockpit` reads planning and integration data in
parallel. A failure on one side is displayed as partial availability while the
other side remains visible.
