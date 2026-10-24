import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn<typeof fetch>() }));
vi.mock("../../../../server-api", () => ({ apiFetch: apiFetchMock }));
import { GET, POST } from "./route";

describe("order list proxy recovery", () => {
  it("binds durable production recovery reads to the requested order and original intent", async () => {
    const id = "019f0000-0000-7000-8000-000000000001", other = "019f0000-0000-7000-8000-000000000002";
    const view = { id, kind: "approved_design", orderId: other, lineIds: [id], status: "prepared", createdAt: "2026-10-20T00:00:00.000Z",
      expiresAt: "2026-10-27T00:00:00.000Z", leaseExpiresAt: null, acknowledged: false, canExecute: true, canCancel: true,
      summary: null, receipt: null, errorCode: null };
    const url = "http://web.test/api/order-centers/production-commands";
    for (const query of ["", `?orderId=${other}&orderId=${other}`, `?orderId=${other}&tenantId=caller`])
      expect((await GET(new Request(url + query), context(["production-commands"]))).status).toBe(400);
    apiFetchMock.mockResolvedValueOnce(Response.json({ items: [view], truncated: false }));
    const saved = await GET(new Request(`${url}?orderId=${other}&lineId=${id}`), context(["production-commands"]));
    expect(saved.status).toBe(200); expect(saved.headers.get("cache-control")).toBe("private, no-store");
    expect(apiFetchMock.mock.lastCall?.[0]).toBe(`http://api.test/v1/order-centers/production-commands?orderId=${other}&lineId=${id}`);
    apiFetchMock.mockResolvedValueOnce(Response.json({ items: [{ ...view, orderId: id }], truncated: false }));
    expect((await GET(new Request(`${url}?orderId=${other}`), context(["production-commands"]))).status).toBe(502);
    apiFetchMock.mockResolvedValueOnce(Response.json({ ...view, id: other }));
    expect((await GET(new Request(`${url}/${id}`), context(["production-commands", id]))).status).toBe(502);
  });
  it("accepts only an intent ID for recovery and rejects caller bodies, leases and arbitrary actions", async () => {
    const id = "019f0000-0000-7000-8000-000000000001", other = "019f0000-0000-7000-8000-000000000002";
    const path = ["production-commands", id, "execute"], url = `http://web.test/api/order-centers/${path.join("/")}`;
    const request = (body: unknown = {}, origin = "http://web.test", query = "") => new Request(url + query,
      { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
    for (const body of [{ leaseToken: id }, { input: {} }, { id: other }, [], null]) expect((await POST(request(body), context(path))).status).toBe(400);
    expect((await POST(request({}, "http://outside.test"), context(path))).status).toBe(403);
    expect((await POST(request({}, "http://web.test", "?tenantId=caller"), context(path))).status).toBe(400);
    expect((await POST(request(), context(["production-commands", id, "publish"])) ).status).toBe(404);
    apiFetchMock.mockRejectedValueOnce(new Error("Synthetic uncertain response"));
    expect((await POST(request(), context(path))).status).toBe(502);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(apiFetchMock.mock.lastCall?.[1]?.body))).toEqual({});
  });
  it("validates native production reads and source identity without caller-selected scope", async () => {
    const id = "019f0000-0000-7000-8000-000000000001", other = "019f0000-0000-7000-8000-000000000002";
    const workspace = { items: [], nextCursor: null, canCreate: false, contextAuthority: "synthetic-authority" };
    apiFetchMock.mockResolvedValueOnce(Response.json(workspace));
    const response = await GET(new Request("http://web.test/api/order-centers/native?q=SKU"), context(["native"]));
    expect(response.status).toBe(200); expect(await response.json()).toEqual(workspace); expect(response.headers.get("cache-control")).toBe("private, no-store");
    for (const query of ["?tenantId=caller", "?q=one&q=two", "?after=bad"])
      expect((await GET(new Request(`http://web.test/api/order-centers/native${query}`), context(["native"]))).status).toBe(400);
    const path = ["native", "lines", id], url = `http://web.test/api/order-centers/${path.join("/")}`;
    const detail = { line: { id, orderId: id, orderNumber: "Synthetic order", title: "Synthetic item", skuCode: null, quantity: 3, allocatedQuantity: 0, workflowState: "in_production", blockers: [] },
      sku: null, specifications: [], source: null, designs: [], designsTruncated: false, routes: [], routesTruncated: false, productions: [], canCreate: true, contextAuthority: "synthetic-authority", diagnostics: [] };
    apiFetchMock.mockResolvedValueOnce(Response.json(detail));
    expect((await GET(new Request(url), context(path))).status).toBe(200);
    apiFetchMock.mockResolvedValueOnce(Response.json({ ...detail, line: { ...detail.line, id: other } }));
    expect((await GET(new Request(url), context(path))).status).toBe(502);
    apiFetchMock.mockResolvedValueOnce(Response.json(detail));
    expect((await GET(new Request(`${url}?specificationVersionId=${id}`), context(path))).status).toBe(502);
    const factoryPath = [...path, "factories"], query = new URLSearchParams({ specificationVersionId: id, routingDecisionId: id, purchaseOrderVersionId: other });
    apiFetchMock.mockResolvedValueOnce(Response.json([]));
    expect((await GET(new Request(`${url}/factories?${query}`), context(factoryPath))).status).toBe(200);
    expect(apiFetchMock.mock.lastCall?.[0]).toBe(`http://api.test/v1/order-centers/${factoryPath.join("/")}?${query}`);
    for (const quantity of [1, 100000]) {
      apiFetchMock.mockResolvedValueOnce(Response.json([]));
      expect((await GET(new Request(`${url}/factories?${query}&quantity=${quantity}`), context(factoryPath))).status).toBe(200);
      expect(apiFetchMock.mock.lastCall?.[0]).toBe(`http://api.test/v1/order-centers/${factoryPath.join("/")}?${query}&quantity=${quantity}`);
      expect(apiFetchMock.mock.lastCall?.[1]).toMatchObject({ method: "GET", cache: "no-store" });
      expect(apiFetchMock.mock.lastCall?.[1]?.body).toBeUndefined();
    }
    for (const invalid of ["quantity=0", "quantity=-1", "quantity=1.5", "quantity=100001", "quantity=not-a-number", "quantity=1&quantity=2", `routingDecisionId=${id}`, "tenantId=caller"])
      expect((await GET(new Request(`${url}/factories?${query}&${invalid}`), context(factoryPath))).status).toBe(400);
    expect(apiFetchMock).toHaveBeenCalledTimes(7);
  });
  it("submits a validated native production request once and binds its receipt to the requested order and line", async () => {
    const id = "019f0000-0000-7000-8000-000000000001", other = "019f0000-0000-7000-8000-000000000002";
    const path = ["native", "orders", id, "production"], url = `http://web.test/api/order-centers/${path.join("/")}`;
    const input = { orderLineId: other, factoryId: id, factoryVersionId: id, capabilityVersionId: id, routingDecisionId: id, purchaseOrderVersionId: id,
      designVersionId: id, productionAssetIds: [id], expectedCompletionAt: "2026-10-30T00:00:00.000Z", instructions: "Synthetic approved request", idempotencyKey: "original-synthetic-key",
      manufacturing: { versionId: id, orderUnitConfirmed: true }, productConfirmation: { specificationVersionId: id, note: "Synthetic explicit confirmation" } };
    const request = (origin = "http://web.test", value: unknown = input, query = "") => new Request(url + query, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(value) });
    expect((await POST(request("http://outside.test"), context(path))).status).toBe(403);
    expect((await POST(request("http://web.test", { ...input, tenantId: "caller" }), context(path))).status).toBe(400);
    expect((await POST(request("http://web.test", input, "?tenant=caller"), context(path))).status).toBe(400);
    apiFetchMock.mockResolvedValueOnce(Response.json({ productionOrderId: id, orderId: id, lineId: other }, { status: 201 }));
    const saved = await POST(request(), context(path)); expect(saved.status).toBe(201); expect(saved.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.parse(String(apiFetchMock.mock.lastCall?.[1]?.body))).toEqual(input);
    apiFetchMock.mockResolvedValueOnce(Response.json({ productionOrderId: id, orderId: other, lineId: other }));
    expect((await POST(request(), context(path))).status).toBe(502);
    apiFetchMock.mockResolvedValueOnce(Response.json({ productionOrderId: id, orderId: id, lineId: id }));
    expect((await POST(request(), context(path))).status).toBe(502);
    apiFetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect((await POST(request(), context(path))).status).toBe(503);
    expect(apiFetchMock).toHaveBeenCalledTimes(4);
  });
  it("validates current production availability and rejects caller scope or inconsistent upstream quantities", async () => {
    const id = "019f0000-0000-7000-8000-000000000001", path = ["lines", id, "production-availability"], url = `http://web.test/api/order-centers/${path.join("/")}`;
    const value = { lineId: id, orderedQuantity: 4, allocatedQuantity: 3, availableQuantity: 1, canRelease: true, revision: 2, projectionVersion: 4 };
    apiFetchMock.mockResolvedValueOnce(Response.json(value));
    const response = await GET(new Request(url), context(path));
    expect(response.status).toBe(200); expect(await response.json()).toEqual(value); expect(response.headers.get("cache-control")).toBe("private, no-store");
    apiFetchMock.mockResolvedValueOnce(Response.json({ ...value, availableQuantity: 2 }));
    expect((await GET(new Request(url), context(path))).status).toBe(502);
    apiFetchMock.mockResolvedValueOnce(Response.json({ ...value, lineId: "019f0000-0000-7000-8000-000000000002" }));
    expect((await GET(new Request(url), context(path))).status).toBe(502);
    for (const query of ["?tenantId=caller", "?includePrivate=true", "?quantity=2"]) expect((await GET(new Request(url + query), context(path))).status).toBe(400);
    expect(apiFetchMock).toHaveBeenCalledTimes(3);
  });
  it("forwards the exact split quantity to factory checks and rejects ambiguous or invalid quantities", async () => {
    const id = "019f0000-0000-7000-8000-000000000001", path = ["lines", id, "factories"], url = `http://web.test/api/order-centers/${path.join("/")}`;
    apiFetchMock.mockResolvedValueOnce(Response.json([]));
    expect((await GET(new Request(`${url}?renderId=${id}&quantity=1`), context(path))).status).toBe(200);
    expect(apiFetchMock.mock.lastCall?.[0]).toBe(`http://api.test/v1/order-centers/${path.join("/")}?renderId=${id}&quantity=1`);
    for (const query of ["quantity=0", "quantity=1.5", "quantity=100001", "quantity=1&quantity=2", "quantity=1&tenantId=caller"])
      expect((await GET(new Request(`${url}?renderId=${id}&${query}`), context(path))).status).toBe(400);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });
  it("preserves only the post-commit authority change code without retrying the write", async () => {
    const id = "019f0000-0000-7000-8000-000000000001", path = ["orders", id, "release"];
    for (const code of ["authority_changed", "private_upstream_detail"]) {
      apiFetchMock.mockResolvedValueOnce(Response.json({ message: "Synthetic conflict", code }, { status: 409 }));
      const response = await POST(new Request(`http://web.test/api/order-centers/${path.join("/")}`, {
        method: "POST", headers: { origin: "http://web.test", "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: "synthetic-original" }),
      }), context(path));
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe(code === "authority_changed" ? code : undefined);
    }
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });
  it("reads exact manufacturing sources privately and refuses duplicate, malformed or caller-tenant query parameters", async () => {
    const id = "019f0000-0000-7000-8000-000000000001", path = ["lines", id, "manufacturing"], url = `http://web.test/api/order-centers/${path.join("/")}`;
    apiFetchMock.mockImplementation(async () => Response.json({ source: null, items: [] }));
    for (const query of ["", `?originalProductionOrderId=${id}`, `?after=${id}`, `?nativeSpecificationVersionId=${id}`]) {
      const response = await GET(new Request(url + query), context(path));
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(apiFetchMock.mock.lastCall?.[0]).toBe(`http://api.test/v1/order-centers/${path.join("/")}${query}`);
    }
    for (const query of ["?tenantId=caller", "?after=bad", `?after=${id}&after=${id}`, `?originalProductionOrderId=${id}&includePrivate=true`, `?originalProductionOrderId=${id}&nativeSpecificationVersionId=${id}`])
      expect((await GET(new Request(url + query), context(path))).status).toBe(400);
    expect(apiFetchMock).toHaveBeenCalledTimes(4);
  });
  it("forwards explicit physical-group reads and one same-origin write without caller tenant selection or automatic retry", async () => {
    const id = "019f0000-0000-7000-8000-000000000001", path = ["production", id, "quality-groups"], url = `http://web.test/api/order-centers/${path.join("/")}`;
    apiFetchMock.mockImplementation(async () => Response.json({ groups: [] }));
    const response = await GET(new Request(url), context(path));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await GET(new Request(url + "?tenantId=caller"), context(path))).status).toBe(400);
    const request = (origin: string, query = "") => new Request(url + query, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: "synthetic-original-key" }) });
    expect((await POST(request("https://another.test"), context(path))).status).toBe(403);
    expect((await POST(request("http://web.test", "?group=caller"), context(path))).status).toBe(400);
    apiFetchMock.mockRejectedValueOnce(new Error("Synthetic uncertain group response"));
    expect((await POST(request("http://web.test"), context(path))).status).toBe(502);
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });
  it("reads shipment source editors privately and never retries or selects a caller tenant for version writes", async () => {
    const id = "019f0000-0000-7000-8000-000000000001", readPath = ["shipments", id, "source-editor"], writePath = ["shipments", id, "versions"];
    apiFetchMock.mockImplementation(async () => Response.json({ synthetic: true }));
    const response = await GET(new Request(`http://web.test/api/order-centers/${readPath.join("/")}`), context(readPath));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await GET(new Request(`http://web.test/api/order-centers/${readPath.join("/")}?tenantId=chosen`), context(readPath))).status).toBe(400);
    const write = (origin: string) => new Request(`http://web.test/api/order-centers/${writePath.join("/")}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ expectedCurrentVersion: 1 }) });
    expect((await POST(write("https://other.test"), context(writePath))).status).toBe(403);
    apiFetchMock.mockRejectedValueOnce(new Error("Synthetic uncertain version outcome"));
    expect((await POST(write("http://web.test"), context(writePath))).status).toBe(502);
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });
  it("forwards only the explicit private or financial design view and refuses query-based tenant or write selection", async () => {
    const line = "019f0000-0000-7000-8000-000000000001", path = ["lines", line, "design-agent"], url = `http://web.test/api/order-centers/${path.join("/")}`;
    apiFetchMock.mockImplementation(async () => Response.json({ run: null }));
    for (const query of ["", "?view=full", "?view=financial"]) {
      const response = await GET(new Request(`${url}${query}`), context(path));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(apiFetchMock.mock.lastCall?.[0]).toBe(`http://api.test/v1/order-centers/${path.join("/")}${query}`);
    }
    for (const query of ["?view=financial&view=full", "?view=unknown", "?view=financial&tenantId=chosen", "?includePrivate=false"]) {
      expect((await GET(new Request(`${url}${query}`), context(path))).status).toBe(400);
    }
    const write = new Request(`${url}/resume?view=financial`, { method: "POST", headers: { origin: "http://web.test", "content-type": "application/json" }, body: "{}" });
    expect((await POST(write, context([...path, "resume"]))).status).toBe(400);
    expect(apiFetchMock).toHaveBeenCalledTimes(3);
  });
  it("allows private task reads and same-origin bounded delivery preparation without replay or caller tenant", async () => {
    const id = "019f0000-0000-7000-8000-000000000001", path = ["lines", id, "task"], url = `http://web.test/api/order-centers/${path.join("/")}`;
    apiFetchMock.mockImplementation(async () => Response.json({ task: {} }));
    const result = await GET(new Request(url), context(path));
    expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe(`http://api.test/v1/order-centers/${path.join("/")}`);
    expect((await GET(new Request(`${url}?tenantId=${id}`), context(path))).status).toBe(400);
    const write = (origin: string, query = "") => new Request(`${url}/prepare-delivery${query}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ groupId: "a".repeat(64), expectedFingerprint: "b".repeat(64) }) });
    expect((await POST(write("https://other.test"), context([...path, "prepare-delivery"]))).status).toBe(403);
    expect((await POST(write("http://web.test", "?tenantId=x"), context([...path, "prepare-delivery"]))).status).toBe(400);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    apiFetchMock.mockRejectedValue(new Error("Synthetic transport loss"));
    expect((await POST(write("http://web.test"), context([...path, "prepare-delivery"]))).status).toBe(502);
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });
  it("keeps review reads private and rejects tenant selection, duplicate or overlong ranges", async () => {
    vi.stubEnv("API_BASE_URL", "http://api.test");
    apiFetchMock.mockResolvedValue(Response.json({ orders: [] }));
    const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
    const query = "?from=2026-10-01T00%3A00%3A00Z&to=2026-10-08T00%3A00%3A00Z";
    const result = await GET(new Request(`http://web.test/api/order-centers/review${query}`), context(["review"]));
    expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe(`http://api.test/v1/order-centers/review${query}`);
    for (const invalid of ["?tenantId=chosen", "?sku=A&sku=B", "?from=2026-01-01T00:00:00Z&to=2026-10-01T00:00:00Z"])
      expect((await GET(new Request(`http://web.test/api/order-centers/review${invalid}`), context(["review"]))).status).toBe(400);
    const line = "019f0000-0000-7000-8000-000000000001";
    expect((await GET(new Request(`http://web.test/api/order-centers/lines/${line}/review?tenantId=chosen`), context(["lines", line, "review"]))).status).toBe(400);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });
  beforeEach(() => {
    apiFetchMock.mockReset();
    vi.stubEnv("API_BASE_URL", "http://api.test");
  });
  afterEach(() => vi.unstubAllEnvs());
  const context = (path: string[]) => ({ params: Promise.resolve({ path }) });

  it("proxies same-origin intake checks privately and rejects cross-origin requests", async () => {
    const line = "019f0000-0000-7000-8000-000000000001";
    apiFetchMock.mockResolvedValue(Response.json({ ready: false, issues: [] }));
    const request = (origin: string) => new Request(`http://web.test/api/order-centers/lines/${line}/intake-check`, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 0 }),
    });
    const response = await POST(request("http://web.test"), context(["lines", line, "intake-check"]));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe(`http://api.test/v1/order-centers/lines/${line}/intake-check`);
    const rejected = await POST(request("http://other.test"), context(["lines", line, "intake-check"]));
    expect(rejected.status).toBe(403); expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it("propagates cancellation of an obsolete list query to the upstream read", async () => {
    const abort = new AbortController();
    apiFetchMock.mockImplementation(async (_url, init) => {
      abort.abort();
      expect(init?.signal?.aborted).toBe(true);
      return Response.json({ items: [] });
    });
    await GET(
      new Request("http://web.test/api/order-centers/workspace?stage=pending_review", {
        signal: abort.signal,
      }),
      context(["workspace"]),
    );
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe(
      "http://api.test/v1/order-centers/workspace?stage=pending_review",
    );
  });

  it("returns a recoverable gateway message without exposing the upstream failure", async () => {
    apiFetchMock.mockRejectedValue(new Error("Private upstream connection details"));
    const response = await GET(
      new Request("http://web.test/api/order-centers/options"),
      context(["options"]),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ message: "订单服务暂时无法连接，请重试" });
  });

  it("does not replay an order write after an upstream failure", async () => {
    const lineId = "019f0000-0000-7000-8000-000000000001";
    apiFetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const response = await POST(
      new Request(`http://web.test/api/order-centers/lines/${lineId}/actions`, {
        method: "POST",
        headers: { origin: "http://web.test", "content-type": "application/json" },
        body: JSON.stringify({ action: "push", idempotencyKey: "synthetic-only" }),
      }),
      context(["lines", lineId, "actions"]),
    );
    expect(response.status).toBe(502);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
  });
  it("allows only the whole-order read and explicit same-origin operations", async () => {
    const id = "019f0000-0000-7000-8000-000000000001";
    apiFetchMock.mockImplementation(async () => Response.json({ recorded: true }));
    expect((await GET(new Request(`http://web.test/api/order-centers/orders/${id}/fulfillment`), context(["orders", id, "fulfillment"]))).status).toBe(200);
    expect((await GET(new Request(`http://web.test/api/order-centers/orders/${id}/fulfillment?tenantId=${id}`), context(["orders", id, "fulfillment"]))).status).toBe(400);
    for (const action of ["release", "production-progress", "quality-pass", "shipments"]) {
      const path = ["orders", id, action];
      const request = (origin: string, query = "") => new Request(`http://web.test/api/order-centers/${path.join("/")}${query}`, {
        method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ items: [], idempotencyKey: "synthetic" }),
      });
      const calls = apiFetchMock.mock.calls.length;
      expect((await POST(request("http://other.test"), context(path))).status).toBe(403);
      expect((await POST(request("http://web.test", "?tenantId=ignored"), context(path))).status).toBe(400);
      expect(apiFetchMock).toHaveBeenCalledTimes(calls);
      expect((await POST(request("http://web.test"), context(path))).status).toBe(200);
      expect(apiFetchMock.mock.calls.at(-1)?.[0]).toBe(`http://api.test/v1/order-centers/orders/${id}/${action}`);
    }
    expect((await POST(new Request(`http://web.test/api/order-centers/orders/${id}/purchase-label`, { method: "POST" }), context(["orders", id, "purchase-label"]))).status).toBe(404);
  });
  it("requires one render ID for factory options and validates factory filters without accepting tenant selection", async () => {
    const id = "019f0000-0000-7000-8000-000000000001";
    apiFetchMock.mockImplementation(async () => Response.json([]));
    for (const query of ["", `?renderId=${id}&renderId=${id}`, `?renderId=${id}&tenantId=${id}`, "?renderId=invalid"]) {
      expect((await GET(new Request(`http://web.test/api/order-centers/lines/${id}/factories${query}`), context(["lines", id, "factories"]))).status).toBe(400);
    }
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect((await GET(new Request(`http://web.test/api/order-centers/lines/${id}/factories?renderId=${id}`), context(["lines", id, "factories"]))).status).toBe(200);
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe(`http://api.test/v1/order-centers/lines/${id}/factories?renderId=${id}`);
    expect((await GET(new Request(`http://web.test/api/order-centers/deliveries?factory=${id}`), context(["deliveries"]))).status).toBe(200);
    const calls = apiFetchMock.mock.calls.length;
    for (const query of [`?factory=${id}&factory=${id}`, "?factory=invalid", `?factory=${id}&tenantId=${id}`]) expect((await GET(new Request(`http://web.test/api/order-centers/deliveries${query}`), context(["deliveries"]))).status).toBe(400);
    expect(apiFetchMock).toHaveBeenCalledTimes(calls);
  });

  it("reads whole detail and scopes delivery history to an order without accepting caller tenant or duplicate filters", async () => {
    const id = "019f0000-0000-7000-8000-000000000001";
    apiFetchMock.mockImplementation(async () => Response.json({ recorded: true }));
    expect((await GET(new Request(`http://web.test/api/order-centers/lines/${id}/order-detail`), context(["lines", id, "order-detail"]))).status).toBe(200);
    expect(apiFetchMock.mock.calls.at(-1)?.[0]).toBe(`http://api.test/v1/order-centers/lines/${id}/order-detail`);
    expect((await GET(new Request(`http://web.test/api/order-centers/lines/${id}/order-detail?tenantId=${id}`), context(["lines", id, "order-detail"]))).status).toBe(400);
    expect((await GET(new Request(`http://web.test/api/order-centers/deliveries?order=${id}`), context(["deliveries"]))).status).toBe(200);
    expect(apiFetchMock.mock.calls.at(-1)?.[0]).toBe(`http://api.test/v1/order-centers/deliveries?order=${id}`);
    const calls = apiFetchMock.mock.calls.length;
    for (const query of [`?order=${id}&order=${id}`, "?order=invalid", `?order=${id}&tenantId=${id}`]) expect((await GET(new Request(`http://web.test/api/order-centers/deliveries${query}`), context(["deliveries"]))).status).toBe(400);
    expect(apiFetchMock).toHaveBeenCalledTimes(calls);
  });

  it.each([["lines", "platform-deadline"], ["shipments", "platform-confirmation"]])("forwards %s %s only from the same origin", async (collection, action) => {
    const id = "019f0000-0000-7000-8000-000000000001";
    apiFetchMock.mockResolvedValue(Response.json({ recorded: true }));
    const request = (origin: string) => new Request(`http://web.test/api/order-centers/${collection}/${id}/${action}`, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ evidenceReference: "Synthetic evidence" }),
    });
    expect((await POST(request("http://other.test"), context([collection, id, action]))).status).toBe(403);
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect((await POST(request("http://web.test"), context([collection, id, action]))).status).toBe(200);
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe(`http://api.test/v1/order-centers/${collection}/${id}/${action}`);
  });

  it("exposes design progress and explicit recovery actions only from the same origin", async () => {
    const id = "019f0000-0000-7000-8000-000000000001";
    apiFetchMock.mockImplementation(async () => Response.json({ run: null }));
    expect((await GET(new Request(`http://web.test/api/order-centers/lines/${id}/design-agent`), context(["lines", id, "design-agent"]))).status).toBe(200);
    for (const action of ["resume", "takeover", "restore-response"]) {
      const path = ["lines", id, "design-agent", action];
      const request = (origin: string) => new Request(`http://web.test/api/order-centers/${path.join("/")}`, {
        method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ runId: id, expectedRevision: 1, idempotencyKey: id }),
      });
      const before = apiFetchMock.mock.calls.length;
      expect((await POST(request("http://foreign.test"), context(path))).status).toBe(403);
      expect(apiFetchMock).toHaveBeenCalledTimes(before);
      expect((await POST(request("http://web.test"), context(path))).status).toBe(200);
    }
    const before = apiFetchMock.mock.calls.length;
    expect((await POST(new Request(`http://web.test/api/order-centers/lines/${id}/design-agent/approve`, {
      method: "POST", headers: { origin: "http://web.test", "content-type": "application/json" }, body: "{}",
    }), context(["lines", id, "design-agent", "approve"]))).status).toBe(404);
    expect(apiFetchMock).toHaveBeenCalledTimes(before);
  });

  it("reads pinned source files only with one explicit current work revision", async () => {
    const id = "019f0000-0000-7000-8000-000000000001";
    const path = ["lines", id, "source-files", "source-2"];
    const url = `http://web.test/api/order-centers/${path.join("/")}`;
    for (const query of ["", "?revision=0", "?revision=-1", "?revision=1.5", "?revision=2147483648", "?revision=1&revision=2", "?revision=1&versionId=other", "?versionId=1", "?revision=1&attempt=-1", "?revision=1&attempt=1.5", "?revision=1&attempt=2147483648", "?revision=1&attempt=0&attempt=1"]) {
      expect((await GET(new Request(`${url}${query}`), context(path))).status).toBe(400);
    }
    expect(apiFetchMock).not.toHaveBeenCalled();
    apiFetchMock.mockResolvedValue(new Response("synthetic bytes", { headers: {
      "content-type": "image/png", "content-disposition": "attachment; filename=synthetic.png",
    } }));
    const result = await GET(new Request(`${url}?revision=3`), context(path));
    expect(result.status).toBe(200);
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe(`http://api.test/v1/order-centers/${path.join("/")}?revision=3`);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(result.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(result.headers.get("content-disposition")).toBe("attachment; filename=synthetic.png");
    expect(result.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await GET(new Request(`${url}?revision=3`), context(["lines", id, "source-files", "../foreign"]))).status).toBe(404);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1, 25])("allows source image retry attempt %s without forwarding it to the API", async (attempt) => {
    const id = "019f0000-0000-7000-8000-000000000001";
    const path = ["lines", id, "source-files", "source-2"];
    apiFetchMock.mockResolvedValue(new Response("synthetic bytes"));
    expect((await GET(new Request(`http://web.test/api/order-centers/${path.join("/")}?revision=3&attempt=${attempt}`), context(path))).status).toBe(200);
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe(`http://api.test/v1/order-centers/${path.join("/")}?revision=3`);
  });
});
