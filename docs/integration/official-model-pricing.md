# Official API price checks

The model billing workbench displays a versioned official USD Standard rate card,
and calculates against the original provider-reported usage. The initial card was
checked on 2026-10-29. It covers exact `gpt-6.1-sol`, `gpt-image-2`,
`gpt-image-2.5-flare`, and `gpt-image-2.5-sunburst` IDs. Similar names are not aliases.

Primary sources:

- [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [GPT Image 2](https://developers.openai.com/api/docs/models/gpt-image-2)
- [GPT Image 2.5 Flare](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare)
- [GPT Image 2.5 Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)
- [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Image costs and cached inputs](https://developers.openai.com/api/docs/guides/image-generation#cost-and-latency)

Sol Standard prices per million tokens are $2 ordinary input, $0.10 cached reads,
$2.50 30-minute cache writes, $5 12-hour cache writes, and $10 output. Input above
272,000 tokens applies 2x input/cache prices and 1.5x output prices to the whole
request. Ordinary input subtracts both cache reads and writes. Reasoning tokens
are part of output. Neither cache counts nor reasoning are added to total tokens.

The three image models use $5 text input, $8 image input, and $30 image output per
million tokens. Direct Images requests do not receive cached-input discounts.
Responses image-tool cache hits can be absent from usage; their input price stays
unknown without sufficient evidence. Equal token rates do not imply equal cost
per image.

The normalizer retains reported cache-write totals and 30-minute/12-hour splits
as optional fields in the existing nullable usage receipt. Absence remains
unknown. Old receipts are not rewritten. The pure calculator uses integer money
products and rounds the full sum once to eight USD decimals. Partial data exposes
only its known subtotal and missing components, never an invented grand total.

`GET /v1/model-billing/workspace` includes `officialPriceCatalog` and adds terminal
order-design call metadata to the tenant-scoped list. `GET
/v1/model-billing/order_design/:callId` is a read-only price check. It reads the
original call and budget metadata under current billing permissions and forced
RLS; no order plaintext, image, prompt or model credential is read. The Web proxy
does not forward order-design confirmation writes, and the API also rejects them.

Official Standard calculations are distinct from provider-reported cost and the
existing invoice/usage/support reconciliation history. They do not confirm an
invoice, modify a budget, start a model, or relax an execution limit. Batch, Flex,
Fast, Ultrafast, regional premiums and separate tool charges are not silently
assumed. Changing rates requires a newly reviewed source version. A future price
card is not evidence of a historical invoice.
