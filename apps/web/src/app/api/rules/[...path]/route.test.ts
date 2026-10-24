import { beforeEach, afterEach, expect, it, vi } from "vitest";
const { upstream } = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>() }));
vi.mock("../../../../server-api", () => ({ apiFetch: upstream }));
import { GET, POST } from "./route";
const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
beforeEach(() => { vi.stubEnv("API_BASE_URL", "http://api.test"); upstream.mockReset(); });
afterEach(() => vi.unstubAllEnvs());
it("allows only named routes, rejects cross-origin writes and does not replay failed mutations", async () => {
  expect((await GET(new Request("http://web.test/api/rules/private"), context(["private"]))).status).toBe(404);
  expect((await POST(new Request("http://web.test/api/rules/initialize", { method: "POST", headers: { origin: "http://other.test", "content-type": "application/json" }, body: "{}" }), context(["initialize"]))).status).toBe(403);
  expect(upstream).not.toHaveBeenCalled();
  upstream.mockRejectedValue(new Error("private database endpoint"));
  const response = await POST(new Request("http://web.test/api/rules/create", { method: "POST", headers: { origin: "http://web.test", "content-type": "application/json" }, body: "{}" }), context(["create"]));
  expect(response.status).toBe(502); expect(await response.text()).not.toContain("database"); expect(upstream).toHaveBeenCalledTimes(1);
});
it("uses private no-store responses and cancels obsolete reads", async () => {
  const abort = new AbortController();
  upstream.mockImplementation(async (_url, init) => { abort.abort(); expect(init?.signal?.aborted).toBe(true); return Response.json({ rules: [] }); });
  const response = await GET(new Request("http://web.test/api/rules/workspace", { signal: abort.signal }), context(["workspace"]));
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
