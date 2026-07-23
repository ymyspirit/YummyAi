import { describe, expect, it } from "vitest";

import { MarketplaceConnectorError, parseRetryAfter } from "./errors.js";

describe("marketplace connector errors", () => {
  it("normalizes retry-after seconds and dates", () => {
    expect(parseRetryAfter("2.5")).toBe(2_500);
    expect(parseRetryAfter("Sun, 19 Jul 2026 00:00:10 GMT", Date.parse("2026-07-19T00:00:00Z"))).toBe(10_000);
    expect(parseRetryAfter("invalid")).toBeUndefined();
  });

  it("marks only rate limits and retryable upstream failures for retry", () => {
    expect(new MarketplaceConnectorError("etsy", "rate_limited", "quota", 4_000).retryable).toBe(true);
    expect(new MarketplaceConnectorError("amazon", "authorization", "revoked").retryable).toBe(false);
  });
});
