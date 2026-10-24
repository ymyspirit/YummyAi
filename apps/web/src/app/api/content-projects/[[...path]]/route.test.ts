import { afterEach, describe, expect, it, vi } from "vitest";
import { createEntityId } from "@yummyai/contracts";
vi.mock("../../../../server-api", () => ({ apiFetch: vi.fn() }));
import { apiFetch } from "../../../../server-api";
import { GET } from "./route";
const get = (path: string[] = [], query = "") => GET(new Request(`http://localhost:3000/api/content-projects${path.length ? `/${path.join("/")}` : ""}${query}`), { params: Promise.resolve({ path }) });
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
describe("content project local authenticated read proxy", () => {
  it("allows the pillow list and exact order route without widening the read allowlist", async () => {
    vi.stubEnv("API_BASE_URL", "http://127.0.0.1:8000");
    vi.mocked(apiFetch).mockResolvedValue(Response.json({}));
    expect((await get(["pillow"], "?stage=in_review&page=2")).status).toBe(200);
    expect(vi.mocked(apiFetch).mock.calls[0]?.[0]).toBe("http://127.0.0.1:8000/v1/content-projects/pillow?q=&page=2&pageSize=20&stage=in_review");
    const id = createEntityId();
    expect((await get(["pillow", "orders", id])).status).toBe(200);
    expect((await get(["pillow", "orders", id], "?tenantId=other")).status).toBe(400);
    expect((await get(["pillow", "orders", id, "resume"])).status).toBe(404);
    expect((await get(["pillow"], "?stage=made-up")).status).toBe(400);
  });
  it("passes only validated filters and forwards an existing authenticated response privately", async () => {
    vi.stubEnv("API_BASE_URL", "http://127.0.0.1:8000");
    vi.mocked(apiFetch).mockResolvedValue(Response.json({ items: [] }));
    const response = await get([], "?q=original&page=2");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(vi.mocked(apiFetch).mock.calls[0]?.[0]).toBe("http://127.0.0.1:8000/v1/content-projects?q=original&page=2&pageSize=20");
  });
  it("rejects caller-selected tenancy, path traversal and invalid paging before a network call", async () => {
    vi.stubEnv("API_BASE_URL", "http://127.0.0.1:8000");
    for (const query of ["?tenantId=other", "?page=-1", "?page=1.5", "?pageSize=100"]) expect((await get([], query)).status).toBe(400);
    expect((await get([createEntityId(), "export"])).status).toBe(404);
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
  });
  it("fails closed in production and for cross-site requests", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await get()).status).toBe(403);
    vi.stubEnv("NODE_ENV", "test");
    const response = await GET(new Request("http://localhost:3000/api/content-projects", { headers: { "sec-fetch-site": "cross-site" } }), { params: Promise.resolve({}) });
    expect(response.status).toBe(403); expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
  });
  it("preserves authorization failures without leaking upstream bodies", async () => {
    vi.stubEnv("API_BASE_URL", "http://127.0.0.1:8000");
    vi.mocked(apiFetch).mockResolvedValue(Response.json({ privateDetail: "synthetic" }, { status: 403 }));
    const response = await get([createEntityId()]);
    expect(response.status).toBe(403); expect(await response.text()).not.toContain("synthetic");
  });
});
