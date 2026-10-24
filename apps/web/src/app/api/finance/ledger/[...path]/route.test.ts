import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEntityId } from "@yummyai/contracts";
const upstream = vi.hoisted(() => vi.fn());
vi.mock("../../../../../server-api", () => ({ apiFetch: upstream }));
import * as route from "./route";

const supplierId = createEntityId(), billId = createEntityId(), at = "2026-07-02T00:00:00.000Z";
const prefix = "http://localhost:3130/api/finance/ledger", context = (...path: string[]) => ({ params: Promise.resolve({ path }) });
const request = (path: string, query = "") => new Request(`${prefix}/${path}${query}`);
const upperId = "ffffffff-ffff-7fff-bfff-ffffffffffff", beforeId = "7fffffff-ffff-7fff-bfff-ffffffffffff", olderId = "00000000-0000-7000-8000-000000000001";
const scope = "a".repeat(64);
const position = (overrides: Record<string, unknown> = {}) => ({ v: 1, scope, upperId, id: beforeId, ...overrides });
const cursor = (overrides: Record<string, unknown> = {}) => Buffer.from(JSON.stringify(position(overrides))).toString("base64url");
const bill = () => ({ id: billId, supplierId, kind: "factory_invoice", externalBillId: "SYNTHETIC-LEDGER-BILL", currency: "USD", amountMinor: 100,
  creditMinor: 20, debitMinor: 0, voidedMinor: 0, netAmountMinor: 80, lifecycle: "active", issuedAt: at, dueAt: null,
  procurementInvoiceId: null, procurementProofId: null, sourceStatus: "current", allocatedMinor: 0, outstandingMinor: 80, status: "unallocated", recordedAt: at });
const summary = () => ({ kind: "bills", id: billId, reference: "SYNTHETIC-LEDGER-BILL", recordedAt: at, amountMinor: 100,
  currency: "USD", netAmountMinor: 80, status: "active", supplierId, parentId: supplierId });
const page = (limit = 25, parentId: string | null = null) => ({ kind: "bills", parentId, limit, order: "id_desc", consistency: "live",
  upperBoundId: billId, items: [summary()], hasMore: false, nextCursor: null });
const detail = () => ({ kind: "bills", id: billId, record: bill(), children: [{ kind: "allocations", parentId: billId }, { kind: "bill_adjustments", parentId: billId }] });
beforeEach(() => { upstream.mockReset(); vi.stubEnv("API_BASE_URL", "http://127.0.0.1:8130/"); });
afterEach(() => vi.unstubAllEnvs());

describe("read-only finance ledger BFF preserves actual scope, pagination and private evidence", () => {
  it("forwards one default list through the authenticated API helper without caller-selected tenant or bearer headers", async () => {
    upstream.mockResolvedValue(Response.json(page())); const response = await route.GET(request("bills"), context("bills"));
    expect(response.status).toBe(200); expect(await response.json()).toEqual(page()); expect(upstream).toHaveBeenCalledOnce();
    const [url, init] = upstream.mock.calls[0]!; expect(url).toBe("http://127.0.0.1:8130/v1/finance/ledger/bills?limit=25");
    expect(init.cache).toBe("no-store"); expect(init.signal).toBeInstanceOf(AbortSignal); expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).has("authorization")).toBe(false); expect(new Headers(init.headers).has("x-tenant-id")).toBe(false);
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it("preserves the exact cursor and normalized parent/page size instead of restarting at the first page", async () => {
    const original = cursor(); upstream.mockResolvedValue(Response.json({ ...page(1, supplierId), upperBoundId: upperId }));
    const response = await route.GET(request("bills", `?parentId=${supplierId.toUpperCase()}&limit=1&cursor=${original}`), context("bills"));
    expect(response.status).toBe(200); const url = new URL(upstream.mock.calls[0]![0]);
    expect(Object.fromEntries(url.searchParams)).toEqual({ parentId: supplierId, limit: "1", cursor: original });
  });
  it("forwards an exact by-ID detail and its actual parent with no list parameters", async () => {
    upstream.mockResolvedValue(Response.json(detail()));
    const response = await route.GET(request(`bills/${billId}`, `?parentId=${supplierId}`), context("bills", billId.toUpperCase()));
    expect(response.status).toBe(200); expect(await response.json()).toEqual(detail());
    expect(upstream.mock.calls[0]![0]).toBe(`http://127.0.0.1:8130/v1/finance/ledger/bills/${billId}?parentId=${supplierId}`);
  });
  it("does not expose any mutation route and rejects non-allowlisted kinds or nested actions before I/O", async () => {
    expect("POST" in route).toBe(false); expect("PATCH" in route).toBe(false); expect("DELETE" in route).toBe(false);
    for (const path of [[], ["bank_transfers"], ["bills", billId, "adjustments"]])
      expect((await route.GET(request(path.join("/")), context(...path))).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each(["?limit=1&limit=1", "?cursor=YQ&cursor=YQ", `?parentId=${supplierId}&parentId=${supplierId}`,
    "?tenantId=caller", "?kind=payments", "?offset=500", "?limit=01", "?limit=101", "?cursor=YQ=="])("rejects duplicate or unsupported list query %s", async query => {
    expect((await route.GET(request("bills", query), context("bills"))).status).toBe(400); expect(upstream).not.toHaveBeenCalled();
  });
  it("rejects unsupported parents, absent mandatory procurement parents and list conditions on a detail request", async () => {
    expect((await route.GET(request("statements", `?parentId=${supplierId}`), context("statements"))).status).toBe(400);
    expect((await route.GET(request("procurement_adjustments"), context("procurement_adjustments"))).status).toBe(400);
    for (const query of ["?limit=1", "?cursor=YQ", `?parentId=${supplierId}&parentId=${supplierId}`])
      expect((await route.GET(request(`bills/${billId}`, query), context("bills", billId))).status).toBe(400);
    expect((await route.GET(request("bills/not-an-id"), context("bills", "not-an-id"))).status).toBe(400); expect(upstream).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 404])("preserves upstream HTTP %i with a safe private response instead of exposing original details", async status => {
    upstream.mockResolvedValue(Response.json({ message: "SYNTHETIC-PRIVATE-CREDENTIAL", record: "not-public" }, { status }));
    const response = await route.GET(request("bills"), context("bills")); expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(await response.text()).not.toContain("SYNTHETIC-PRIVATE"); expect(upstream).toHaveBeenCalledOnce();
  });
  it("rejects a valid page for a different collection, parent, page size or first upper bound", async () => {
    const wrongKind = { ...page(), kind: "payments", items: [{ ...summary(), kind: "payments" }] };
    for (const value of [wrongKind, page(10), page(25, supplierId), { ...page(), upperBoundId: createEntityId() }]) {
      upstream.mockResolvedValueOnce(Response.json(value)); expect((await route.GET(request("bills"), context("bills"))).status).toBe(502);
    }
  });
  it("rejects a repeated continuation cursor and a page whose rows disagree with its claimed parent or ID order", async () => {
    const original = cursor(); upstream.mockResolvedValueOnce(Response.json({ ...page(1), upperBoundId: upperId, hasMore: true, nextCursor: original }));
    expect((await route.GET(request("bills", `?limit=1&cursor=${original}`), context("bills"))).status).toBe(502);
    for (const value of [{ ...page(), parentId: supplierId, items: [{ ...summary(), parentId: createEntityId() }] },
      { ...page(), items: [summary(), summary()] }]) {
      upstream.mockResolvedValueOnce(Response.json(value)); expect((await route.GET(request("bills"), context("bills"))).status).toBe(502);
    }
  });
  it("rejects malformed and noncanonical request positions before upstream I/O", async () => {
    const value = position(), raw = JSON.stringify(value);
    for (const original of ["not_json", Buffer.from("null").toString("base64url"),
      Buffer.from(JSON.stringify(value, null, 1)).toString("base64url"), Buffer.from(`${raw.slice(0, -1)},"v":1}`).toString("base64url"),
      cursor({ id: upperId, upperId: beforeId })]) {
      expect((await route.GET(request("bills", `?limit=1&cursor=${original}`), context("bills"))).status).toBe(400);
    }
    expect(upstream).not.toHaveBeenCalled();
  });
  it("accepts only the original upper bound and strictly older rows on a continuation", async () => {
    const value = { ...page(1), upperBoundId: upperId }, original = cursor();
    upstream.mockResolvedValueOnce(Response.json(value));
    expect((await route.GET(request("bills", `?limit=1&cursor=${original}`), context("bills"))).status).toBe(200);
    for (const changed of [{ ...value, upperBoundId: billId }, { ...value, items: [{ ...summary(), id: beforeId }] },
      { ...value, items: [{ ...summary(), id: upperId }] }]) {
      upstream.mockResolvedValueOnce(Response.json(changed));
      expect((await route.GET(request("bills", `?limit=1&cursor=${original}`), context("bills"))).status).toBe(502);
    }
  });
  it("binds every returned next cursor to the actual last row, original upper bound and continuation scope", async () => {
    const original = cursor(), next = cursor({ id: billId }), value = { ...page(1), upperBoundId: upperId, hasMore: true, nextCursor: next };
    upstream.mockResolvedValueOnce(Response.json(value));
    const good = await route.GET(request("bills", `?limit=1&cursor=${original}`), context("bills")); expect(good.status).toBe(200); expect((await good.json()).nextCursor).toBe(next);
    for (const nextCursor of [cursor({ id: billId, scope: "b".repeat(64) }), cursor({ id: olderId }), cursor({ id: billId, upperId: beforeId }), "not_json"]) {
      upstream.mockResolvedValueOnce(Response.json({ ...value, nextCursor }));
      expect((await route.GET(request("bills", `?limit=1&cursor=${original}`), context("bills"))).status).toBe(502);
    }
  });
  it("anchors even a first-page continuation to its actual last row and upper bound", async () => {
    const next = cursor({ upperId: billId, id: billId }), value = { ...page(1), hasMore: true, nextCursor: next };
    upstream.mockResolvedValueOnce(Response.json(value)); expect((await route.GET(request("bills", "?limit=1"), context("bills"))).status).toBe(200);
    for (const nextCursor of [cursor({ upperId: billId, id: olderId }), cursor({ id: billId }), "not_json"]) {
      upstream.mockResolvedValueOnce(Response.json({ ...value, nextCursor }));
      expect((await route.GET(request("bills", "?limit=1"), context("bills"))).status).toBe(502);
    }
  });
  it("rejects detail identity, parent and child-relation substitutions even if each record is individually well formed", async () => {
    const otherId = createEntityId();
    for (const value of [{ ...detail(), id: otherId, record: { ...bill(), id: otherId }, children: [{ kind: "allocations", parentId: otherId }, { kind: "bill_adjustments", parentId: otherId }] },
      { ...detail(), record: { ...bill(), supplierId: otherId } }, { ...detail(), children: [] }]) {
      upstream.mockResolvedValueOnce(Response.json(value));
      expect((await route.GET(request(`bills/${billId}`, `?parentId=${supplierId}`), context("bills", billId))).status).toBe(502);
    }
  });
  it("keeps unsupported actual procurement evidence explicit and rejects a missing authorized bill currency", async () => {
    const sourceId = createEntityId(), reviewId = createEntityId(), value = { kind: "procurement_adjustments", id: sourceId, billCurrency: "USD",
      record: { billId, procurementAdjustmentId: sourceId, procurementReviewId: reviewId, code: "source_format_not_supported" }, children: [] };
    upstream.mockResolvedValueOnce(Response.json(value));
    const response = await route.GET(request(`procurement_adjustments/${sourceId}`, `?parentId=${billId}`), context("procurement_adjustments", sourceId));
    expect(response.status).toBe(200); expect(await response.json()).toEqual(value);
    const { billCurrency: omitted, ...missingCurrency } = value; void omitted; upstream.mockResolvedValueOnce(Response.json(missingCurrency));
    expect((await route.GET(request(`procurement_adjustments/${sourceId}`, `?parentId=${billId}`), context("procurement_adjustments", sourceId))).status).toBe(502);
  });
  it("refuses malformed JSON, excessive bodies and transport failures once without leaking or retrying", async () => {
    for (const value of [new Response("{not-json"), new Response("x".repeat(8 * 1024 * 1024 + 1)), new Response(null)]) {
      upstream.mockResolvedValueOnce(value); expect((await route.GET(request("bills"), context("bills"))).status).toBe(502);
    }
    upstream.mockRejectedValueOnce(new Error("SYNTHETIC-PRIVATE-TOKEN"));
    const response = await route.GET(request("bills"), context("bills")); expect(response.status).toBe(502); expect(await response.text()).not.toContain("SYNTHETIC-PRIVATE");
    expect(upstream).toHaveBeenCalledTimes(4);
  });
  it("does not call an absent API configuration or mask a backend failure as an empty ledger", async () => {
    vi.stubEnv("API_BASE_URL", ""); expect((await route.GET(request("bills"), context("bills"))).status).toBe(503); expect(upstream).not.toHaveBeenCalled();
    vi.stubEnv("API_BASE_URL", "http://127.0.0.1:8130"); upstream.mockResolvedValue(Response.json({ secret: "SYNTHETIC-PRIVATE" }, { status: 500 }));
    expect((await route.GET(request("bills"), context("bills"))).status).toBe(502);
  });
});
