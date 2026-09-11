import { afterEach, describe, expect, it, vi } from "vitest";
import { isSameOriginRequest } from "./same-origin-request";

describe("same origin browser writes", () => {
  afterEach(() => vi.unstubAllEnvs());
  const request = (origin: string, host = "127.0.0.1:3000", site = "same-origin") => new Request("http://localhost:3000/api/orders/reports/import", { headers: { origin, host, "sec-fetch-site": site } });
  it("accepts numeric loopback Host after Next dev normalizes the internal URL", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isSameOriginRequest(request("http://127.0.0.1:3000"))).toBe(true);
  });
  it("rejects cross-site requests, different ports, protocols and spoofed hosts", () => {
    vi.stubEnv("NODE_ENV", "development");
    for (const value of [request("http://127.0.0.1:3000", "localhost:3000"), request("http://127.0.0.1:4175", "127.0.0.1:4175"), request("https://127.0.0.1:3000"), request("http://evil.test:3000", "evil.test:3000"), request("http://localhost:3000", "localhost:3000", "cross-site")]) expect(isSameOriginRequest(value)).toBe(false);
  });
  it("keeps production origin checks exact and rejects a missing origin", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isSameOriginRequest(request("http://127.0.0.1:3000"))).toBe(false);
    expect(isSameOriginRequest(request("http://localhost:3000", "localhost:3000"))).toBe(true);
    expect(isSameOriginRequest(new Request("http://localhost:3000/api/production-editor/projects"))).toBe(false);
  });
});
