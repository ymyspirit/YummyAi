# Actual model usage

New ordinary Assist executions use `assist-execution-v2` with
`outputTokenPolicy: "provider"`. Responses and Chat Completions omit their output
token limit fields. Studio text calls also omit these fields. A provider's model
context, response transport limits and structured output validation still apply.
Frozen executions and benchmark inputs retain their original policy and checksum.

`ModelTokenUsage` records provider-reported input, output, cached input and total
tokens. Cached input and reasoning tokens are subsets, not additional tokens.
Only two reported input/output components may supply a missing total; its basis
is recorded. Missing or contradictory units stay unknown. A real reported zero
stays zero. No historical rows are backfilled with invented usage.

Assist, order-design model calls and POD invocation receipts persist nullable
`token_usage` JSON in migration 193. Capture occurs before content interpretation
and image validation. Recovery reuses the original request and receipt; polling
never adds usage. Conflicting replacement receipts are rejected. Assist late
responses may add the first usage receipt to an original submitted terminal run,
without changing its outcome, lease, result or closed financial columns. Generic
POD terminal receipt restrictions remain in force.

Server-side summaries read the complete authorized original-call ledger, including
submitted failed and cancelled attempts. Assist totals retain owner, kind, scope
and benchmark boundaries. Order-design exposes run and work-item totals. Pending
tasks that never submitted are not calls. A page of history is not a lifetime
total. Partial coverage is an explicitly labeled known subtotal.

An explicit automation recipe `costPolicy: "unlimited"` with a null task cap
allows an unpriced call; omission preserves the existing priced/capped policy.
An unpriced unlimited call reserves zero money while its actual cost remains
unknown. This is not a free call. Original call identity, provider authorization,
call count and organization budget policy continue to apply. An organization
policy requiring an estimate is not bypassed by the recipe. Actual usage and
provider invoices remain the billing evidence; custom-channel prices must not be
inferred from another provider's public list prices.
