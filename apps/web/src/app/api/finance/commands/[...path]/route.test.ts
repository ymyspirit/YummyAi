import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import type { FinanceCommandDetail, PrepareFinanceCommand } from "@yummyai/contracts/finance/finance-command";
const upstream = vi.hoisted(() => vi.fn());
vi.mock("../../../../../server-api", () => ({ apiFetch: upstream }));
import { GET, POST } from "./route";

const id = createEntityId(), supplierId = createEntityId(), at = "2026-07-15T00:00:00.000Z", root = "http://localhost:3130/api/finance/commands";
const key = "synthetic-finance-command-original", authority = "synthetic-personal-finance-authority";
const context = (...path: string[]) => ({ params: Promise.resolve({ path }) });
const original = (): PrepareFinanceCommand => ({ kind: "payment_record", targetId: null, input: { supplierId, externalPaymentId: "SYNTHETIC-ORIGINAL-PAYMENT",
  currency: "USD", amountMinor: 29, paidAt: at, method: "bank_transfer", evidenceReference: "SYNTHETIC-RECORDED-EVIDENCE", idempotencyKey: key } });
const detail = (overrides: Partial<FinanceCommandDetail> = {}): FinanceCommandDetail => ({ id, kind: "payment_record", targetId: null,
  status: "prepared", requestKey: key, createdAt: at, expiresAt: "2026-07-22T00:00:00.000Z", completedAt: null, acknowledged: false,
  originalRetained: true, result: null, contextAuthority: authority, canExecute: true, canCancel: true, canAcknowledge: false, blockReason: null, ...overrides });
const done = () => detail({ status: "succeeded", completedAt: at, result: { kind: "payment_record", id: createEntityId(), parentId: null, version: null },
  canExecute: false, canCancel: false, canAcknowledge: true });
function summary(value = detail()) { const { canExecute, canCancel, canAcknowledge, blockReason, ...rest } = value; void canExecute; void canCancel; void canAcknowledge; void blockReason; return rest; }
const get = (path = "", query = "") => new Request(`${root}${path}${query}`);
const post = (path = "", body: unknown = original(), headers: Record<string, string> = {}) => new Request(`${root}${path}`, {
  method: "POST", headers: { origin: "http://localhost:3130", "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});
function statement(): Extract<PrepareFinanceCommand, { kind: "statement_record" }> {
  return { kind: "statement_record", targetId: null, input: { accountId: null, provider: "manual", statementKind: "operational_cost",
    sourceIdentity: { schemaVersion: 2, kind: "named_source", sourceName: "SYNTHETIC-BFF-SOURCE" }, externalStatementId: "SYNTHETIC-REPORT",
    periodStart: at, periodEnd: at, observedAt: at, sourceCurrency: "USD", idempotencyKey: key,
    lines: [{ lineKey: "one", sourceEntryId: "synthetic-original-component", factType: "production_cost", direction: "debit", amountMinor: 29,
      currency: "USD", occurredAt: at, externalReference: null, orderId: null, orderLineId: null, skuId: null, listingId: null, supplierId: null,
      correctionKind: "original", correctsFactId: null }] } };
}
beforeEach(() => { upstream.mockReset(); vi.stubEnv("API_BASE_URL", "http://127.0.0.1:8130"); });
afterEach(() => vi.unstubAllEnvs());

describe("personal finance-command BFF retains original requests and small actual receipts", () => {
  it("forwards the original key and full normalized body once without trusting browser-selected tenant or authorization headers", async () => {
    upstream.mockResolvedValue(Response.json(detail(), { status: 201 }));
    const response = await POST(post("", original(), { "x-tenant-id": createEntityId(), authorization: "SYNTHETIC-UNTRUSTED-BROWSER" }), context());
    expect(response.status).toBe(201); expect(await response.json()).toEqual(detail()); expect(upstream).toHaveBeenCalledOnce();
    const [url, init] = upstream.mock.calls[0]!; expect(url).toBe("http://127.0.0.1:8130/v1/finance/commands");
    expect(init.method).toBe("POST"); expect(init.cache).toBe("no-store"); expect(JSON.parse(init.body)).toEqual(original());
    expect(new Headers(init.headers).has("authorization")).toBe(false); expect(new Headers(init.headers).has("x-tenant-id")).toBe(false);
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("retains root as an explicit source filter and keeps private originals out of list metadata", async () => {
    const page = { items: [summary()], nextCursor: null, unavailableCount: 0, contextAuthority: authority };
    upstream.mockResolvedValue(Response.json(page));
    const response = await GET(get("", "?kind=payment_record&targetId=root"), context());
    expect(response.status).toBe(200); expect(await response.json()).toEqual(page);
    expect(upstream.mock.calls[0]![0]).toBe("http://127.0.0.1:8130/v1/finance/commands?kind=payment_record&targetId=root");
    expect(JSON.stringify(page)).not.toContain("SYNTHETIC-RECORDED-EVIDENCE");
  });
  it("loads a single private original only through its exact ID endpoint and retains its current authority", async () => {
    const payload = { id, original: original(), blockReason: null, contextAuthority: authority };
    upstream.mockResolvedValue(Response.json(payload));
    const response = await GET(get(`/${id}/original`), context(id, "original"));
    expect(response.status).toBe(200); expect(await response.json()).toEqual(payload);
    expect(upstream.mock.calls[0]![0]).toBe(`http://127.0.0.1:8130/v1/finance/commands/${id}/original`);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it.each(["execute", "cancel", "acknowledge"] as const)("forwards only explicit empty %s with the same command identity", async action => {
    const payload = action === "execute" ? done() : action === "cancel" ? detail({ status: "cancelled", originalRetained: false, completedAt: at,
      canExecute: false, canCancel: false, canAcknowledge: true }) : { ...done(), acknowledged: true, originalRetained: false, canAcknowledge: false };
    upstream.mockResolvedValue(Response.json(payload));
    const response = await POST(post(`/${id}/${action}`, {}), context(id.toUpperCase(), action));
    expect(response.status).toBe(200); expect(await response.json()).toEqual(payload);
    expect(upstream.mock.calls[0]![0]).toBe(`http://127.0.0.1:8130/v1/finance/commands/${id}/${action}`);
    expect(JSON.parse(upstream.mock.calls[0]![1].body)).toEqual({});
  });
  it("rejects cross-origin or cross-site mutations before upstream authentication or I/O", async () => {
    expect((await POST(post("", original(), { origin: "https://foreign.example" }), context())).status).toBe(403);
    expect((await POST(post("", original(), { "sec-fetch-site": "cross-site" }), context())).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("rejects expanded authority, replaced action bodies, invalid targets and non-JSON input without forwarding", async () => {
    for (const raw of [null, { ...original(), tenantId: createEntityId() }, { ...original(), authoritySnapshot: {} }, { ...original(), targetId: supplierId }])
      expect((await POST(post("", raw), context())).status).toBe(400);
    for (const raw of [null, undefined, { input: original().input }, { idempotencyKey: "new-replacement-key" }]) {
      const request = raw === undefined ? new Request(`${root}/${id}/execute`, { method: "POST", headers: { origin: "http://localhost:3130", "content-type": "application/json" } }) : post(`/${id}/execute`, raw);
      expect((await POST(request, context(id, "execute"))).status).toBe(400);
    }
    expect((await POST(new Request(root, { method: "POST", headers: { origin: "http://localhost:3130", "content-type": "text/plain" }, body: "synthetic" }), context())).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("rejects non-allowlisted paths, duplicate and unknown queries and every detail-query override", async () => {
    expect((await GET(get("/not-a-uuid"), context("not-a-uuid"))).status).toBe(404);
    expect((await POST(post(`/${id}/approve`, {}), context(id, "approve"))).status).toBe(404);
    expect((await GET(get(`/${id}/execute`), context(id, "execute"))).status).toBe(404);
    for (const query of ["?kind=payment_record&kind=bill_record", "?tenantId=synthetic", "?limit=500", "?targetId=null"])
      expect((await GET(get("", query), context())).status).toBe(400);
    expect((await GET(get(`/${id}`, "?original=true"), context(id))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 404, 409, 413, 422, 429, 503])("preserves real %i failures while withholding private upstream data and never retrying", async status => {
    upstream.mockResolvedValue(Response.json({ code: "finance_command_input_unavailable", message: "SYNTHETIC-PRIVATE-FINANCIAL-BODY", token: "SYNTHETIC-PRIVATE-TOKEN" }, { status }));
    const response = await GET(get(`/${id}`), context(id)); expect(response.status).toBe(status);
    const body = await response.text(); expect(body).toContain("finance_command_input_unavailable"); expect(body).not.toContain("SYNTHETIC-PRIVATE");
    expect(upstream).toHaveBeenCalledOnce(); expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("returns one sanitized failure on network loss without fallback or a replacement write", async () => {
    upstream.mockRejectedValue(new Error("SYNTHETIC-PRIVATE-CONNECTION-DETAILS"));
    const response = await POST(post(`/${id}/execute`, {}), context(id, "execute"));
    expect(response.status).toBe(502); expect(await response.text()).not.toContain("SYNTHETIC-PRIVATE"); expect(upstream).toHaveBeenCalledOnce();
  });
  it("rejects a substituted command, mismatched original target or request key and a forged result kind", async () => {
    for (const change of [{ kind: "bill_record" as const }, { targetId: supplierId }, { requestKey: "synthetic-another-key" }]) {
      upstream.mockResolvedValueOnce(Response.json(detail(change), { status: 201 }));
      expect((await POST(post(), context())).status).toBe(502);
    }
    upstream.mockResolvedValueOnce(Response.json(detail({ id: createEntityId() })));
    expect((await GET(get(`/${id}`), context(id))).status).toBe(502);
    const receipt = done(); upstream.mockResolvedValueOnce(Response.json({ ...receipt, result: { ...receipt.result, kind: "bill_record" } }));
    expect((await POST(post(`/${id}/execute`, {}), context(id, "execute"))).status).toBe(502);
    upstream.mockResolvedValueOnce(Response.json({ id: createEntityId(), original: original(), blockReason: null, contextAuthority: authority }));
    expect((await GET(get(`/${id}/original`), context(id, "original"))).status).toBe(502);
  });
  it("rejects private-body expansion in a summary or a missing authority on the single original response", async () => {
    upstream.mockResolvedValueOnce(Response.json({ items: [{ ...summary(), original: original() }], nextCursor: null, unavailableCount: 0, contextAuthority: authority }));
    expect((await GET(get(), context())).status).toBe(502);
    upstream.mockResolvedValueOnce(Response.json({ id, original: original(), blockReason: null }));
    expect((await GET(get(`/${id}/original`), context(id, "original"))).status).toBe(502);
  });
  it("accepts one full multi-page-sized original beyond the small metadata limit without clipping any row", async () => {
    const value = statement(); value.input.lines = Array.from({ length: 5000 }, (_, index) => ({ ...value.input.lines[0]!, lineKey: `line-${index}`, sourceEntryId: `source-${index}` }));
    const payload = { id, original: value, blockReason: null, contextAuthority: authority };
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(512 * 1024); upstream.mockResolvedValue(Response.json(payload));
    const response = await GET(get(`/${id}/original`), context(id, "original")); expect(response.status).toBe(200); expect(await response.json()).toEqual(payload);
  });
  it("bounds even a syntactically empty action's streamed whitespace body before forwarding", async () => {
    const request = new Request(`${root}/${id}/execute`, { method: "POST", headers: { origin: "http://localhost:3130", "content-type": "application/json" }, body: `${" ".repeat(2048)}{}` });
    expect((await POST(request, context(id, "execute"))).status).toBe(413); expect(upstream).not.toHaveBeenCalled();
  });
  it("does not convert an unexpected upstream success status into a confirmed prepare or execute result", async () => {
    upstream.mockResolvedValueOnce(Response.json(detail(), { status: 202 }));
    expect((await POST(post(), context())).status).toBe(502);
    upstream.mockResolvedValueOnce(Response.json(done(), { status: 201 }));
    expect((await POST(post(`/${id}/execute`, {}), context(id, "execute"))).status).toBe(502);
  });
  it("validates returned metadata against the requested kind, root scope and before position", async () => {
    const page = (row: ReturnType<typeof summary>) => ({ items: [row], nextCursor: null, unavailableCount: 0, contextAuthority: authority });
    for (const row of [summary(detail({ kind: "bill_record" })), summary(detail({ targetId: supplierId }))]) {
      upstream.mockResolvedValueOnce(Response.json(page(row)));
      expect((await GET(get("", "?kind=payment_record&targetId=root"), context())).status).toBe(502);
    }
    upstream.mockResolvedValueOnce(Response.json(page(summary())));
    expect((await GET(get("", `?before=${id}`), context())).status).toBe(502);
  });
  it("rejects invalid UTF8 request bytes rather than silently replacing an original financial reference", async () => {
    const payload = statement(), body = Buffer.from(JSON.stringify(payload));
    const offset = body.indexOf(Buffer.from("SYNTHETIC-REPORT")); body[offset] = 0xff;
    const request = new Request(root, { method: "POST", headers: { origin: "http://localhost:3130", "content-type": "application/json" }, body });
    expect((await POST(request, context())).status).toBe(400); expect(upstream).not.toHaveBeenCalled();
  });
});
