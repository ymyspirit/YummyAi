import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../../server-api", () => ({ apiFetch: vi.fn() }));
import { apiFetch } from "../../../../server-api";
import { GET } from "./route";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("private fulfillment attention proxy", () => {
  it.each(["page=0", "page=1&page=2", "tenantId=other", "source=unknown"])("rejects invalid query %s before any API call", async query => {
    vi.mocked(apiFetch).mockClear();
    const response = await GET(new Request(`http://localhost/api/dashboard/fulfillment-attention?${query}`));
    expect(response.status).toBe(400); expect(apiFetch).not.toHaveBeenCalled();
  });
  it("passes only validated filters and marks the response private", async () => {
    vi.stubEnv("API_BASE_URL", "http://api.invalid");
    const data = { generatedAt: "2026-10-13T00:00:00Z", source: "logistics", page: 2, pageSize: 12, total: 0, hasMore: false, sources: [], items: [] };
    vi.mocked(apiFetch).mockResolvedValue(Response.json(data));
    const response = await GET(new Request("http://localhost/api/dashboard/fulfillment-attention?source=logistics&page=2"));
    expect(apiFetch).toHaveBeenCalledWith("http://api.invalid/v1/dashboard/fulfillment-attention?source=logistics&page=2", expect.objectContaining({ cache: "no-store" }));
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(await response.json()).toEqual(data);
  });
  it("does not disclose upstream failures or replace unavailable data with zero", async () => {
    vi.stubEnv("API_BASE_URL", "http://api.invalid");
    vi.mocked(apiFetch).mockResolvedValue(Response.json({ secret: "synthetic-secret" }, { status: 500 }));
    const response = await GET(new Request("http://localhost/api/dashboard/fulfillment-attention"));
    expect(response.status).toBe(500); const body = await response.json();
    expect(body).not.toHaveProperty("total"); expect(JSON.stringify(body)).not.toContain("synthetic-secret");
  });
});
