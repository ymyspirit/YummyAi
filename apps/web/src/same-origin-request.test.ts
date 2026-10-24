import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSameOriginRequest } from "./same-origin-request";

describe("same origin browser writes", () => {
  beforeEach(() => {
    vi.stubEnv("WEB_ORIGIN", undefined);
    vi.stubEnv("FACTORY_PORTAL_ORIGIN", undefined);
    vi.stubEnv("FACTORY_PORTAL_ONLY", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());
  const request = (origin: string, host = "127.0.0.1:3000", site = "same-origin") => new Request("http://localhost:3000/api/orders/reports/import", { headers: { origin, host, "sec-fetch-site": site } });
  const normalizedWrite = ({ origin, host = "127.0.0.1:3130", site = "same-origin", url = "http://localhost:3130/api/order-centers/summaries" }: {
    origin: string; host?: string; site?: string; url?: string;
  }) => new Request(url, { method: "POST", headers: { origin, host, "sec-fetch-site": site, "content-type": "application/json" } });
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
  it("accepts production Next loopback normalization only for the exact configured ERP origin and Host", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const origin of ["http://127.0.0.1:3130", "http://[::1]:3130"]) {
      vi.stubEnv("WEB_ORIGIN", origin);
      expect(isSameOriginRequest(normalizedWrite({ origin, host: new URL(origin).host }))).toBe(true);
    }
  });
  it("rejects production loopback normalization with absent or mismatched ERP configuration", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const configured of [undefined, "", "http://localhost:3130", "http://127.0.0.1:4175", "https://127.0.0.1:3130", "http://evil.test:3130", "http://127.0.0.1:3130/other"]) {
      vi.stubEnv("WEB_ORIGIN", configured);
      expect(isSameOriginRequest(normalizedWrite({ origin: "http://127.0.0.1:3130" }))).toBe(false);
    }
  });
  it("keeps production configured normalization bounded by Host, fetch site, protocol, port and literal loopback hosts", () => {
    vi.stubEnv("NODE_ENV", "production");
    const cases = [
      { origin: "http://127.0.0.1:3130", host: "localhost:3130" },
      { origin: "http://127.0.0.1:3130", host: "evil.test:3130" },
      { origin: "http://127.0.0.1:3130", site: "cross-site" },
      { origin: "http://127.0.0.1:4175", host: "127.0.0.1:4175" },
      { origin: "https://127.0.0.1:3130" },
      { origin: "http://127.0.0.1:3130", url: "https://localhost:3130/api/order-centers/summaries" },
      { origin: "http://evil.test:3130", host: "evil.test:3130" },
      { origin: "http://127.0.0.1:3130", url: "http://internal.test:3130/api/order-centers/summaries" },
      { origin: "http://127.0.0.2:3130", host: "127.0.0.2:3130" },
      { origin: "null" },
      { origin: "http://127.0.0.1:3130/other" },
    ];
    for (const value of cases) {
      vi.stubEnv("WEB_ORIGIN", value.origin);
      expect(isSameOriginRequest(normalizedWrite(value))).toBe(false);
    }
    vi.stubEnv("WEB_ORIGIN", "http://127.0.0.1:3130");
    expect(isSameOriginRequest(new Request("http://localhost:3130/api/order-centers/summaries", {
      method: "POST", headers: { host: "127.0.0.1:3130", "sec-fetch-site": "same-origin", "content-type": "application/json" },
    }))).toBe(false);
  });
  it("accepts factory production normalization using only the exact factory origin", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FACTORY_PORTAL_ONLY", "1");
    vi.stubEnv("WEB_ORIGIN", "http://127.0.0.1:3130");
    vi.stubEnv("FACTORY_PORTAL_ORIGIN", "http://127.0.0.1:4130");
    expect(isSameOriginRequest(normalizedWrite({
      origin: "http://127.0.0.1:4130", host: "127.0.0.1:4130", url: "http://localhost:4130/api/factory-portal/work-items",
    }))).toBe(true);
    expect(isSameOriginRequest(normalizedWrite({ origin: "http://127.0.0.1:3130" }))).toBe(false);
  });
  it("never borrows ERP configuration for a missing or mismatched factory origin", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FACTORY_PORTAL_ONLY", "1");
    vi.stubEnv("WEB_ORIGIN", "http://127.0.0.1:4130");
    for (const configured of [undefined, "", "http://localhost:4130", "http://127.0.0.1:3130", "https://127.0.0.1:4130"]) {
      vi.stubEnv("FACTORY_PORTAL_ORIGIN", configured);
      expect(isSameOriginRequest(normalizedWrite({
        origin: "http://127.0.0.1:4130", host: "127.0.0.1:4130", url: "http://localhost:4130/api/factory-portal/work-items",
      }))).toBe(false);
    }
  });
  it("never borrows factory configuration outside factory-only mode", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FACTORY_PORTAL_ORIGIN", "http://127.0.0.1:3130");
    for (const mode of [undefined, "", "0"]) {
      vi.stubEnv("FACTORY_PORTAL_ONLY", mode);
      expect(isSameOriginRequest(normalizedWrite({ origin: "http://127.0.0.1:3130" }))).toBe(false);
    }
  });
});
