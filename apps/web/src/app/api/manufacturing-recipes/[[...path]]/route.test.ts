import { createEntityId } from "@yummyai/contracts";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const { upstream } = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>() }));
vi.mock("../../../../server-api", () => ({ apiFetch: upstream }));
import { GET, POST } from "./route";
const context = (path = "") => ({ params: Promise.resolve({ path: path ? path.split("/") : undefined }) });
const post = (body: unknown, origin = "https://erp.example") => new Request("https://erp.example/api/manufacturing-recipes", { method: "POST", headers: {
  "content-type": "application/json", origin, authorization: "untrusted-browser-header", "x-tenant-id": createEntityId(),
}, body: JSON.stringify(body) });
const input = () => ({ spuId: createEntityId(), specificationId: createEntityId(), code: "BOM", idempotencyKey: crypto.randomUUID(),
  content: { specificationVersionId: createEntityId(), name: "Synthetic draft", outputQuantity: 1, outputUnit: "each", materials: [], operations: [] } });
describe("personal manufacturing proxy", () => {
  beforeEach(() => { vi.stubEnv("API_BASE_URL", "https://api.example"); upstream.mockReset(); });
  afterEach(() => vi.unstubAllEnvs());
  it("uses server identity and keeps the original request key in normalized content", async () => {
    const body = input(); upstream.mockResolvedValue(Response.json({ data: {}, contextAuthority: "a".repeat(64) }));
    const response = await POST(post(body), context());
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    const [url, options] = upstream.mock.calls[0]!;
    expect(url).toBe("https://api.example/v1/manufacturing-recipes");
    expect(options?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(options?.body)).idempotencyKey).toBe(body.idempotencyKey);
  });
  it("rejects other origins, caller-selected authority and unsupported paths before an upstream request", async () => {
    expect((await POST(post(input(), "https://other.example"), context())).status).toBe(403);
    expect((await POST(post({ ...input(), tenantId: createEntityId() }), context())).status).toBe(400);
    expect((await GET(new Request("https://erp.example/api/manufacturing-recipes?tenantId=bad"), context())).status).toBe(400);
    expect((await GET(new Request("https://erp.example/api/manufacturing-recipes/../../secrets"), context("../../secrets"))).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("preserves scoped material search and original selection parameters", async () => {
    const query = new URLSearchParams({ spuId: createEntityId(), search: "fabric", selected: createEntityId(), limit: "50" });
    upstream.mockResolvedValue(Response.json({ data: {}, contextAuthority: "a".repeat(64) }));
    expect((await GET(new Request(`https://erp.example/api/manufacturing-recipes/material-options?${query}`), context("material-options"))).status).toBe(200);
    expect(upstream.mock.calls[0]![0]).toBe(`https://api.example/v1/manufacturing-recipes/material-options?${query}`);
  });
  it("reports an uncertain write and suppresses raw upstream errors", async () => {
    upstream.mockResolvedValue(Response.json({ message: "private SQL failure" }, { status: 500 }));
    const response = await POST(post(input()), context());
    expect(response.status).toBe(500); expect(await response.text()).toContain("提交结果尚未确认");
  });
  it("preserves a post-submission authority change instead of treating it as a rejected business command", async () => {
    upstream.mockResolvedValue(Response.json({ message: "Current authority changed", code: "authority_changed" }, { status: 409 }));
    const response = await POST(post(input()), context());
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "authority_changed" });
  });
});
