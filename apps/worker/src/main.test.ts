import { describe, expect, it } from "vitest";

import { providerAwareBackoff } from "./main.js";

describe("provider-aware job backoff", () => {
  it("respects a longer provider quota window", () => {
    const error = Object.assign(new Error("rate limited"), { retryAfterMs: 42_000 });
    expect(providerAwareBackoff(1, "provider-aware", error)).toBe(42_000);
  });

  it("keeps exponential retry spacing and caps untrusted provider values", () => {
    expect(providerAwareBackoff(3, "provider-aware", new Error("upstream"))).toBe(20_000);
    const error = Object.assign(new Error("rate limited"), { retryAfterMs: 60 * 60 * 1_000 });
    expect(providerAwareBackoff(1, "provider-aware", error)).toBe(15 * 60 * 1_000);
  });

  it("rejects unknown custom strategy names", () => {
    expect(() => providerAwareBackoff(1, "unknown", new Error("failed")))
      .toThrow("Unsupported Worker backoff strategy");
  });
});
