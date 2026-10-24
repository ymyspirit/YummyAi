import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { factoryPublicPath } from "./factory-portal-mode";
import { proxy } from "./proxy";
const id = "019f0000-0000-7000-8000-000000000001";
describe("public factory deployment boundary", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("loads encoded Next chunks without opening encoded business paths or static traversal", () => {
    for (const path of [
      "/_next/static/chunks/%5Bturbopack%5D_browser_hmr.js",
      "/_next/static/chunks/0vvp_%40swc_helpers.js",
    ])
      expect(factoryPublicPath(path)).toBe(true);
    for (const path of [
      "/_next/static/%2e%2e/api/orders",
      "/_next/static/chunks/%252e%252e/orders",
      "/_next/static/%5capi%5corders",
      "/_next/static/%ZZ.js",
      "/api/%66actory-portal/session",
    ])
      expect(factoryPublicPath(path)).toBe(false);
  });
  it("allows only factory and immutable static entry paths", () => {
    for (const path of [
      "/factory-work-items",
      "/api/factory-auth/login",
      "/api/factory-auth/callback",
      "/api/factory-auth/logout",
      "/api/factory-portal/session",
      "/api/factory-portal/work-items",
      `/api/factory-portal/work-items/${id}/file`,
      `/api/factory-portal/work-items/${id}/feedback`,
      "/_next/static/chunks/page-123.js",
    ])
      expect(factoryPublicPath(path)).toBe(true);
  });
  it("blocks operator APIs, image and data proxies, management paths and encoded traversal", () => {
    for (const path of [
      "/orders",
      "/knowledge",
      "/api/order-centers/workspace",
      "/api/production-editor/projects",
      "/api/factory-collaboration/workspace",
      "/_next/image",
      "/_next/data/build/orders.json",
      "/api/factory-portal/work-items/not-an-id",
      "/api/factory-portal/work-items/../order-centers",
      "/api/factory-portal/%2e%2e/orders",
      "/_next/static/../../api/orders",
      "/api/factory-portal\\session",
    ])
      expect(factoryPublicPath(path)).toBe(false);
  });
  it("cannot fall back to the operator proxy without a cookie or with a caller bearer header", async () => {
    vi.stubEnv("FACTORY_PORTAL_ONLY", "1");
    vi.stubEnv("API_ACCESS_TOKEN", "synthetic-operator-fallback-must-not-be-used");
    const response = await proxy(
      new NextRequest("https://factory.test/api/order-centers/workspace", {
        headers: { authorization: "Bearer synthetic-caller-token" },
      }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("preserves internal routing outside the independent factory mode and redirects the public root", async () => {
    vi.stubEnv("WEB_AUTH_MODE","local-service");
    vi.stubEnv("FACTORY_PORTAL_ONLY", "");
    expect(
      (await proxy(new NextRequest("http://localhost:3000/orders"))).headers.get("x-middleware-next"),
    ).toBe("1");
    vi.stubEnv("FACTORY_PORTAL_ONLY", "1");
    const root = await proxy(new NextRequest("https://factory.test/"));
    expect(root.headers.get("location")).toBe("https://factory.test/factory-work-items");
  });
});
