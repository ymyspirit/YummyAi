import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { personal, origin } = vi.hoisted(() => ({
  personal: vi.fn<typeof fetch>(),
  origin: vi.fn((request: Request, trusted: string) => {
    if (request.headers.get("origin") !== trusted) throw Error("Synthetic origin denied");
  }),
}));
vi.mock("../../../../factory-auth/server", () => ({
  factoryUserFetch: personal,
  factoryIdentity: () => ({ configuration: { origin: "https://factory.test" } }),
  factoryWriteOrigin: origin,
  factoryAuthFailure: () => Response.json({ message: "Denied" }, { status: 400 }),
}));
import { GET, POST } from "./route";
const id = "019f0000-0000-7000-8000-000000000001",
  ctx = (path: string) => ({ params: Promise.resolve({ path: path.split("/") }) });
beforeEach(() => {
  vi.stubEnv("FACTORY_PORTAL_ONLY", "1");
  personal.mockReset();
  origin.mockClear();
});
afterEach(() => vi.unstubAllEnvs());
it("requires a factory-only deployment and a fixed personal path", async () => {
  vi.stubEnv("FACTORY_PORTAL_ONLY", "0");
  expect(
    (await GET(new Request("https://factory.test/api/factory-portal/session"), ctx("session")))
      .status,
  ).toBe(404);
  vi.stubEnv("FACTORY_PORTAL_ONLY", "1");
  expect(
    (await GET(new Request("https://factory.test/api/factory-portal/orders"), ctx("orders")))
      .status,
  ).toBe(404);
  expect(personal).not.toHaveBeenCalled();
});
it("rejects tenant selection, duplicate filters and cross-origin feedback", async () => {
  for (const query of ["?tenantId=forged", "?q=a&q=b", "?status=completed"])
    expect(
      (
        await GET(
          new Request(`https://factory.test/api/factory-portal/work-items${query}`),
          ctx("work-items"),
        )
      ).status,
    ).toBe(400);
  const request = new Request(`https://factory.test/api/factory-portal/work-items/${id}/feedback`, {
    method: "POST",
    headers: { origin: "https://invalid.test", "content-type": "application/json" },
    body: "{}",
  });
  expect((await POST(request, ctx(`work-items/${id}/feedback`))).status).toBe(400);
  expect(personal).not.toHaveBeenCalled();
});
it("streams only the personal file response with private download headers", async () => {
  personal.mockResolvedValueOnce(
    new Response(new Uint8Array([255, 216, 255]), {
      headers: {
        "content-type": "image/jpeg",
        "content-disposition": "attachment; filename=test.jpg",
        "content-length": "9000",
      },
    }),
  );
  const response = await GET(
    new Request(`https://factory.test/api/factory-portal/work-items/${id}/file`),
    ctx(`work-items/${id}/file`),
  );
  expect(response.headers.get("content-type")).toBe("image/jpeg");
  expect(response.headers.get("content-length")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([255, 216, 255]));
});
