import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { upstream } = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>() }));
vi.mock("../../../../server-api", () => ({ apiFetch: upstream }));
import { GET, POST } from "./route";
const id = "019f0000-0000-7000-8000-000000000001",
  context = (path: string[]) => ({ params: Promise.resolve({ path }) });
const request = (body = "{}", origin = "http://web.test") =>
  new Request("http://web.test/api/model-billing/assist/" + id + "/confirm", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body,
  });
beforeEach(() => {
  vi.stubEnv("API_BASE_URL", "http://api.test");
  upstream.mockReset();
});
afterEach(() => vi.unstubAllEnvs());
it("rejects unapproved paths, cross-origin writes, malformed JSON and large proof bodies", async () => {
  expect(
    (await GET(new Request("http://web.test/api/model-billing/private"), context(["private"])))
      .status,
  ).toBe(404);
  expect(
    (await POST(request("{}", "http://other.test"), context(["assist", id, "confirm"]))).status,
  ).toBe(403);
  expect((await POST(request("{"), context(["assist", id, "confirm"]))).status).toBe(400);
  expect(
    (
      await POST(
        request(JSON.stringify({ body: "凭".repeat(6000) })),
        context(["assist", id, "confirm"]),
      )
    ).status,
  ).toBe(413);
  expect(upstream).not.toHaveBeenCalled();
});
it("preserves cursor and scope queries and keeps financial reads private", async () => {
  upstream.mockResolvedValueOnce(Response.json({ items: [], nextCursor: null }));
  const response = await GET(
    new Request("http://web.test/api/model-billing/workspace?scope=all&after=abcd"),
    context(["workspace"]),
  );
  expect(String(upstream.mock.calls[0]?.[0])).toBe(
    "http://api.test/v1/model-billing/workspace?scope=all&after=abcd",
  );
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
});
it("retains conflict feedback and never retries a possibly committed correction", async () => {
  upstream.mockResolvedValueOnce(
    Response.json({ message: "调用或预算依据已变化" }, { status: 409 }),
  );
  const conflict = await POST(request(), context(["assist", id, "confirm"]));
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ message: "调用或预算依据已变化" });
  upstream.mockRejectedValueOnce(new Error("private financial connection"));
  const failure = await POST(request(), context(["pod", id, "confirm"]));
  expect(failure.status).toBe(502);
  expect(await failure.text()).not.toContain("financial");
  expect(upstream).toHaveBeenCalledTimes(2);
});
it("preserves authorization failures and rollout unavailability without reflecting private upstream diagnostics", async () => {
  for (const status of [401, 403, 503]) {
    upstream.mockResolvedValueOnce(
      Response.json({ message: "sensitive-invoice-data" }, { status }),
    );
    const response = await GET(
      new Request("http://web.test/api/model-billing/assist/" + id),
      context(["assist", id]),
    );
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("sensitive");
  }
});
