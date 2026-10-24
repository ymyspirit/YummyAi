import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { upstream } = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>() }));
vi.mock("../../../../server-api", () => ({ apiFetch: upstream }));
import { GET, POST } from "./route";
const id = "019f0000-0000-7000-8000-000000000001";
const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
const request = (body = "{}", origin = "http://web.test") =>
  new Request("http://web.test/api/knowledge-governance/documents/upload", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body,
  });
beforeEach(() => {
  vi.stubEnv("API_BASE_URL", "http://api.test");
  upstream.mockReset();
});
afterEach(() => vi.unstubAllEnvs());
it("keeps original download behind an explicit write and rejects foreign-origin imports", async () => {
  expect(
    (await GET(new Request("http://web.test"), context(["documents", id, "original"]))).status,
  ).toBe(404);
  expect(
    (await POST(request("{}", "http://foreign.test"), context(["documents", "upload"]))).status,
  ).toBe(403);
  expect((await POST(request("{"), context(["documents", "upload"]))).status).toBe(400);
  expect(upstream).not.toHaveBeenCalled();
});
it("bounds UTF-8 imports and normal writes before forwarding", async () => {
  expect(
    (
      await POST(
        request(JSON.stringify({ base64: "a".repeat(7_400_000) })),
        context(["documents", "upload"]),
      )
    ).status,
  ).toBe(413);
  expect(
    (
      await POST(
        request(JSON.stringify({ reason: "知".repeat(400_000) })),
        context(["sources", "create"]),
      )
    ).status,
  ).toBe(413);
  expect(upstream).not.toHaveBeenCalled();
});
it("preserves access failures without exposing upstream details or retrying writes", async () => {
  upstream.mockResolvedValueOnce(new Response("private diagnostic", { status: 403 }));
  const denied = await GET(new Request("http://web.test"), context(["documents", id]));
  expect(denied.status).toBe(403);
  expect(await denied.text()).not.toContain("diagnostic");
  upstream.mockRejectedValueOnce(new Error("private database token"));
  const failed = await POST(request(), context(["documents", id, "confirm"]));
  expect(failed.status).toBe(502);
  expect(await failed.text()).not.toContain("token");
  expect(upstream).toHaveBeenCalledTimes(2);
});
it("makes account reads private and propagates cancelled reads", async () => {
  const abort = new AbortController();
  upstream.mockImplementation(async (_url, init) => {
    abort.abort();
    expect(init?.signal?.aborted).toBe(true);
    return Response.json({ safeText: "redacted" });
  });
  const response = await GET(
    new Request("http://web.test", { signal: abort.signal }),
    context(["documents", id]),
  );
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
});
