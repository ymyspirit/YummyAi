import { beforeEach, afterEach, it, expect, vi } from "vitest";
const { upstream } = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>() }));
vi.mock("../../../../server-api", () => ({ apiFetch: upstream }));
import { GET, POST } from "./route";
const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
const request = (body = "{}", origin = "http://web.test") =>
  new Request("http://web.test/api/agent-methods/save", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body,
  });
beforeEach(() => {
  vi.stubEnv("API_BASE_URL", "http://api.test");
  upstream.mockReset();
});
afterEach(() => vi.unstubAllEnvs());
it("rejects arbitrary methods/paths, cross-origin JSON and oversized notes without forwarding", async () => {
  expect(
    (await GET(new Request("http://web.test/api/agent-methods/private"), context(["private"])))
      .status,
  ).toBe(404);
  expect((await POST(request("{}", "http://other.test"), context(["save"]))).status).toBe(403);
  expect((await POST(request("{"), context(["save"]))).status).toBe(400);
  expect(
    (await POST(request(JSON.stringify({ notes: "知".repeat(24000) })), context(["save"]))).status,
  ).toBe(413);
  expect(upstream).not.toHaveBeenCalled();
});
it("limits source search and cursor parameters before forwarding", async () => {
  for (const suffix of [
    "?tenantId=forged",
    "?query=" + "a".repeat(161),
    "?after=bad",
    "?query=a&query=b",
  ])
    expect(
      (
        await GET(
          new Request("http://web.test/api/agent-methods/sources" + suffix),
          context(["sources"]),
        )
      ).status,
    ).toBe(400);
  expect(upstream).not.toHaveBeenCalled();
  upstream.mockResolvedValueOnce(Response.json({ choices: [], nextCursor: null }));
  const response = await GET(
    new Request("http://web.test/api/agent-methods/sources?query=%E7%9F%A5%E8%AF%86"),
    context(["sources"]),
  );
  expect(response.status).toBe(200);
  expect(String(upstream.mock.calls[0]![0])).toContain("/v1/agent-methods/sources?query=");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it("preserves current authorization failures and never retries an unknown mutation", async () => {
  upstream.mockResolvedValueOnce(new Response(null, { status: 403 }));
  expect(
    (await GET(new Request("http://web.test/api/agent-methods/workspace"), context(["workspace"])))
      .status,
  ).toBe(403);
  upstream.mockRejectedValueOnce(new Error("private query body"));
  const response = await POST(request(), context(["save"]));
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("query");
  expect(upstream).toHaveBeenCalledTimes(2);
});
it("cancels obsolete reads and bounds forwarded conflict diagnostics", async () => {
  const abort = new AbortController();
  upstream.mockImplementationOnce(async (_url, init) => {
    abort.abort();
    expect(init?.signal?.aborted).toBe(true);
    return Response.json({});
  });
  await GET(
    new Request("http://web.test/api/agent-methods/workspace", { signal: abort.signal }),
    context(["workspace"]),
  );
  upstream.mockResolvedValueOnce(Response.json({ message: "secret".repeat(100) }, { status: 409 }));
  const response = await POST(request(), context(["save"]));
  expect(response.status).toBe(409);
  expect(await response.text()).not.toContain("secret");
});
