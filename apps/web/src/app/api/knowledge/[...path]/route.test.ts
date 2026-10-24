import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { upstream } = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>() }));
vi.mock("../../../../server-api", () => ({ apiFetch: upstream }));
import { GET, POST } from "./route";
const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
const request = (body = "{}", origin = "http://web.test") =>
  new Request("http://web.test/api/knowledge/create", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body,
  });
beforeEach(() => {
  vi.stubEnv("API_BASE_URL", "http://api.test");
  upstream.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

it("rejects arbitrary paths, cross-origin writes, invalid JSON and oversized UTF-8 bodies before forwarding", async () => {
  expect(
    (await GET(new Request("http://web.test/api/knowledge/private"), context(["private"]))).status,
  ).toBe(404);
  expect((await POST(request("{}", "http://other.test"), context(["create"]))).status).toBe(403);
  expect((await POST(request("{"), context(["create"]))).status).toBe(400);
  expect(
    (await POST(request(JSON.stringify({ body: "知".repeat(50_000) })), context(["create"])))
      .status,
  ).toBe(413);
  expect(upstream).not.toHaveBeenCalled();
});
it("preserves authentication failures and never retries a possibly committed mutation", async () => {
  upstream.mockResolvedValueOnce(new Response(null, { status: 401 }));
  expect(
    (await GET(new Request("http://web.test/api/knowledge/workspace"), context(["workspace"])))
      .status,
  ).toBe(401);
  upstream.mockRejectedValueOnce(new Error("private database connection"));
  const response = await POST(request(), context(["create"]));
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("database");
  expect(upstream).toHaveBeenCalledTimes(2);
});
it("keeps history private and forwards cancellation for obsolete reads", async () => {
  const abort = new AbortController();
  upstream.mockImplementation(async (_url, init) => {
    abort.abort();
    expect(init?.signal?.aborted).toBe(true);
    return Response.json({ versions: [] });
  });
  const response = await GET(
    new Request("http://web.test/api/knowledge/workspace", { signal: abort.signal }),
    context(["workspace"]),
  );
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
});
