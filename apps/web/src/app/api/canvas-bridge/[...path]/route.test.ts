import { createEntityId } from "@yummyai/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn<typeof fetch>() }));
vi.mock("../../../../server-api", () => ({ apiFetch: apiFetchMock }));
import { GET, POST } from "./route";
const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
describe("canvas BFF scope and authentication boundary", () => {
  beforeEach(() => { apiFetchMock.mockReset(); vi.stubEnv("API_BASE_URL", "http://api.test"); vi.stubEnv("NODE_ENV", "test"); });
  afterEach(() => vi.unstubAllEnvs());
  it("forwards only allowed paths through server authentication", async () => {
    const id = createEntityId(); apiFetchMock.mockResolvedValue(Response.json({ saved: true }));
    const response = await POST(new Request("http://localhost:3000/api/canvas-bridge/briefs", { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json", authorization: "caller-secret" }, body: "{}" }), context(["briefs", id, "results"]));
    expect(response.ok).toBe(true);
    expect(apiFetchMock).toHaveBeenCalledWith(`http://api.test/v1/canvas-bridge/briefs/${id}/results`, expect.objectContaining({ headers: { "content-type": "application/json" } }));
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("rejects cross-origin writes, unknown routes and production use of the local identity", async () => {
    expect((await POST(new Request("http://localhost:3000/api/canvas-bridge/briefs", { method: "POST", headers: { origin: "https://elsewhere.test" } }), context(["briefs"]))).status).toBe(403);
    expect((await GET(new Request("http://localhost:3000/api/canvas-bridge/admin"), context(["..", "admin"]))).status).toBe(404);
    vi.stubEnv("NODE_ENV", "production");
    expect((await GET(new Request("http://localhost:3000/api/canvas-bridge/briefs"), context(["briefs"]))).status).toBe(403);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
  it("uses the actual loopback Host when Next normalizes the request URL", async () => {
    apiFetchMock.mockResolvedValue(Response.json({ saved: true }));
    const response = await POST(new Request("http://localhost:3000/api/canvas-bridge/briefs", { method: "POST", headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" }, body: "{}" }), context(["briefs"]));
    expect(response.status).toBe(200);
    expect((await POST(new Request("http://localhost:3000/api/canvas-bridge/briefs", { method: "POST", headers: { host: "outside.test:3000", origin: "http://outside.test:3000", "content-type": "application/json" }, body: "{}" }), context(["briefs"]))).status).toBe(403);
  });
  it("bounds uploads without trusting content-length and hides upstream private errors", async () => {
    const response = await POST(new Request("http://localhost:3000/api/canvas-bridge/briefs", { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify("x".repeat(1024 * 1024)) }), context(["briefs"]));
    expect(response.status).toBe(413); expect(apiFetchMock).not.toHaveBeenCalled();
    apiFetchMock.mockResolvedValue(Response.json({ message: "private object key" }, { status: 500 }));
    expect(await (await GET(new Request("http://localhost:3000/api/canvas-bridge/briefs"), context(["briefs"]))).text()).not.toContain("private object");
  });
  it("keeps result thumbnails private and restricts workflow mutations to POST", async () => {
    const id = createEntityId(), versionId = createEntityId();
    apiFetchMock.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/webp" } }));
    const preview = await GET(new Request("http://localhost:3000/preview"), context(["briefs", id, "results", versionId, "preview"]));
    expect(preview.headers.get("content-type")).toBe("image/webp");
    expect(preview.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    apiFetchMock.mockClear();
    for (const action of ["review", "continue", "production"]) {
      expect((await GET(new Request("http://localhost:3000/action"), context(["briefs", id, action]))).status).toBe(404);
      expect((await POST(new Request("http://localhost:3000/action", { method: "POST", headers: { origin: "https://untrusted.test" } }), context(["briefs", id, action]))).status).toBe(403);
    }
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
