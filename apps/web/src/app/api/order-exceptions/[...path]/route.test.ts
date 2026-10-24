import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrderExceptionOperationsQuerySchema } from "@yummyai/contracts/order/exception-operations";
const { upstream } = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>() }));
vi.mock("../../../../server-api", () => ({ apiFetch: upstream }));
import { GET, POST } from "./route";
const orderId = "019f0000-0000-7000-8000-000000000001";
const exceptionId = "019f0000-0000-7000-8000-000000000002";
const url = `http://web.test/api/order-exceptions/${orderId}`;
const context = (path = [orderId]) => ({ params: Promise.resolve({ path }) });
const create = {
  category: "quality",
  code: "MANUAL_REVIEW",
  message: "Synthetic issue",
  idempotencyKey: "synthetic-request",
  expectedOrderSequence: 1,
  expectedSourceChecksum: "a".repeat(64),
};
const resolve = {
  resolution: "Synthetic checked evidence",
  idempotencyKey: "synthetic-resolution",
  expectedSequence: 1,
  expectedSourceChecksum: "b".repeat(64),
};
const record = {
  id: exceptionId,
  orderId,
  category: "quality",
  code: "MANUAL_REVIEW",
  message: "Synthetic issue",
  status: "open",
  resolution: null,
  openedAt: "2026-10-16T00:00:00Z",
  resolvedAt: null,
};
const view = {
  orderId,
  lineId: null,
  label: "Synthetic order",
  orderSequence: 1,
  sourceChecksum: "a".repeat(64),
  asOf: "2026-10-16T00:00:00Z",
  canCreate: true,
  query: OrderExceptionOperationsQuerySchema.parse({}),
  total: 0,
  page: 1,
  pageSize: 25,
  summary: { open: 0, resolved: 0, missingEvent: 0 },
  items: [],
};
const write = (
  body: unknown = create,
  origin = "http://web.test",
  suffix = "",
  contentType = "application/json",
) =>
  new Request(url + suffix, {
    method: "POST",
    headers: { origin, "content-type": contentType },
    body: JSON.stringify(body),
  });
describe("reviewed exception transport boundaries", () => {
  beforeEach(() => {
    upstream.mockReset();
    vi.stubEnv("API_BASE_URL", "http://api.test/");
  });
  afterEach(() => vi.unstubAllEnvs());
  it("rejects unrecognized paths, duplicate filters and caller-selected scope before transport", async () => {
    for (const path of [
      ["invalid"],
      [orderId, "events"],
      [orderId, exceptionId],
      [orderId, exceptionId, "delete"],
      [orderId, exceptionId, "resolve", "extra"],
    ]) {
      expect((await GET(new Request(url), context(path))).status).toBe(404);
      expect((await POST(write(), context(path))).status).toBe(404);
    }
    for (const query of [
      "?tenantId=x",
      "?page=1&page=2",
      "?status=unknown",
      "?pageSize=101",
      "?exceptionId=bad",
    ])
      expect((await GET(new Request(url + query), context())).status).toBe(400);
    expect((await POST(write(create, "http://web.test", "?page=1"), context())).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("requires same-origin JSON and complete reviewed commands, with bounded valid UTF-8", async () => {
    expect((await POST(write(create, "https://other.test"), context())).status).toBe(403);
    expect(
      (await POST(write(create, "http://web.test", "", "application/jsonp"), context())).status,
    ).toBe(403);
    for (const value of [
      { ...create, tenantId: orderId },
      { ...create, expectedOrderSequence: undefined },
      { ...create, expectedSourceChecksum: "wrong" },
      { ...resolve, expectedSequence: undefined },
    ]) {
      const path = "resolution" in value ? [orderId, exceptionId, "resolve"] : [orderId];
      expect((await POST(write(value), context(path))).status).toBe(400);
    }
    expect((await POST(write("a".repeat(9000)), context())).status).toBe(413);
    const invalid = new Request(url, {
      method: "POST",
      headers: { origin: "http://web.test", "content-type": "application/json" },
      body: new Uint8Array([0xff, 0xfe]),
    });
    expect((await POST(invalid, context())).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("uses the original owning endpoints and forwards one pinned command without retries", async () => {
    upstream.mockResolvedValueOnce(Response.json(record));
    expect((await POST(write(), context())).status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe(`http://api.test/v1/orders/${orderId}/exceptions`);
    expect(JSON.parse(String(upstream.mock.calls[0]?.[1]?.body))).toEqual(create);
    upstream.mockResolvedValueOnce(
      Response.json({
        ...record,
        status: "resolved",
        resolution: resolve.resolution,
        resolvedAt: "2026-10-16T01:00:00Z",
      }),
    );
    expect((await POST(write(resolve), context([orderId, exceptionId, "resolve"]))).status).toBe(
      200,
    );
    expect(upstream.mock.calls[1]?.[0]).toBe(
      `http://api.test/v1/orders/${orderId}/exceptions/${exceptionId}/resolve`,
    );
    upstream.mockRejectedValueOnce(new Error("Synthetic unknown outcome"));
    const failed = await POST(write(resolve), context([orderId, exceptionId, "resolve"]));
    expect(failed.status).toBe(502);
    expect(await failed.text()).toContain("操作结果暂未确认");
    expect(upstream).toHaveBeenCalledTimes(3);
  });
  it("keeps private responses uncached and exposes explicit conflict and expired states", async () => {
    upstream.mockResolvedValueOnce(Response.json(view));
    const response = await GET(new Request(url + "?status=open&page=2"), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `http://api.test/v1/orders/${orderId}/exception-operations?status=open&page=2`,
    );
    for (const status of [401, 403, 404, 410]) {
      upstream.mockResolvedValueOnce(
        Response.json({ message: "Synthetic private upstream detail" }, { status }),
      );
      const denied = await GET(new Request(url), context());
      expect(denied.status).toBe(status);
      expect(await denied.text()).not.toContain("Synthetic private");
    }
    upstream.mockResolvedValueOnce(
      Response.json({ message: "订单或异常依据已变化 请重新核对" }, { status: 409 }),
    );
    const conflict = await POST(write(resolve), context([orderId, exceptionId, "resolve"]));
    expect(conflict.status).toBe(409);
    expect(await conflict.text()).toContain("依据已变化");
  });
  it("rejects unexpected successful upstream fields and unavailable API configuration", async () => {
    upstream.mockResolvedValueOnce(Response.json({ ...view, privateBuyer: "Synthetic secret" }));
    const response = await GET(new Request(url), context());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("Synthetic secret");
    vi.stubEnv("API_BASE_URL", "");
    expect((await GET(new Request(url), context())).status).toBe(503);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
