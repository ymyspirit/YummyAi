import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { upstream } = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>() }));
vi.mock("../../../../server-api", () => ({ apiFetch: upstream }));
import { GET, POST } from "./route";
const id = "019f0000-0000-7000-8000-000000000001",
  key = "00000000-0000-4000-8000-000000000001",
  ctx = (path: string) => ({ params: Promise.resolve({ path: path.split("/") }) });
const post = (path: string, value: unknown, origin = "http://web.test") =>
  new Request(`http://web.test/api/factory-collaboration/${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(value),
  });
beforeEach(() => {
  vi.stubEnv("FACTORY_PORTAL_ONLY", "0");
  vi.stubEnv("API_BASE_URL", "http://api.test");
  upstream.mockReset();
});
afterEach(() => vi.unstubAllEnvs());
it("cannot expose the operator identity in factory-only mode", async () => {
  vi.stubEnv("FACTORY_PORTAL_ONLY", "1");
  vi.stubEnv("API_ACCESS_TOKEN", "synthetic-operator");
  expect(
    (
      await GET(
        new Request("http://web.test/api/factory-collaboration/workspace"),
        ctx("workspace"),
      )
    ).status,
  ).toBe(404);
  expect((await POST(post("grants", {}), ctx("grants"))).status).toBe(404);
  expect(upstream).not.toHaveBeenCalled();
});
it("rejects forged tenant, duplicate query, arbitrary path, cross-origin and oversized commands before forwarding", async () => {
  for (const query of ["?tenantId=forged", "?q=x&q=y", "?limit=51", "?cursor="])
    expect(
      (
        await GET(
          new Request(`http://web.test/api/factory-collaboration/workspace${query}`),
          ctx("workspace"),
        )
      ).status,
    ).toBe(400);
  expect(
    (await GET(new Request("http://web.test/api/factory-collaboration/private"), ctx("private")))
      .status,
  ).toBe(404);
  expect((await POST(post("grants", {}, "https://other.test"), ctx("grants"))).status).toBe(403);
  expect((await POST(post("grants", { note: "知".repeat(12000) }), ctx("grants"))).status).toBe(
    413,
  );
  expect(upstream).not.toHaveBeenCalled();
});
it("retains current permission errors and never retries an uncertain original assignment", async () => {
  upstream.mockResolvedValueOnce(new Response(null, { status: 403 }));
  expect(
    (
      await GET(
        new Request("http://web.test/api/factory-collaboration/workspace"),
        ctx("workspace"),
      )
    ).status,
  ).toBe(403);
  const body = {
    deliveryItemId: id,
    fileChecksum: "a".repeat(64),
    packageChecksum: "b".repeat(64),
    expiresAt: "2027-01-01T00:00:00.000Z",
    idempotencyKey: key,
  };
  upstream.mockRejectedValueOnce(Error("Synthetic unknown mutation"));
  expect(
    (await POST(post(`grants/${id}/work-items`, body), ctx(`grants/${id}/work-items`))).status,
  ).toBe(502);
  expect(upstream).toHaveBeenCalledTimes(2);
  expect(upstream.mock.calls[1]![1]?.body).toBe(JSON.stringify(body));
});
