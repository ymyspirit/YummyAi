import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEntityId } from "@yummyai/contracts";
const upstream = vi.hoisted(() => vi.fn());
vi.mock("../../../../../server-api", () => ({ apiFetch: upstream }));
import { GET, POST } from "./route";

const billId = createEntityId(), paymentId = createEntityId(), supplierId = createEntityId(), recordId = createEntityId(), reviewId = createEntityId();
const at = "2026-07-03T00:00:00.000Z", prefix = "http://localhost:3130/api/finance/payables";
const input = () => ({ kind: "credit", amountMinor: 20, externalDocumentId: "SYNTHETIC-ADJUSTMENT", evidenceReference: "Synthetic actual supplier reference",
  occurredAt: at, reasonCode: "SUPPLIER_CORRECTION", expectedNetAmountMinor: 100, idempotencyKey: "synthetic-adjustment-original" });
const paidInput = () => ({ ...input(), kind: "refund" });
const sourceInput = () => ({ kind: "procurement_sync", procurementAdjustmentId: recordId, procurementReviewId: reviewId,
  expectedNetAmountMinor: 100, idempotencyKey: "synthetic-source-sync-original" });
const balance = () => ({ amountMinor: 100, creditMinor: 20, debitMinor: 0, voidedMinor: 0, netAmountMinor: 80, allocatedMinor: 0, outstandingMinor: 80, lifecycle: "active" });
const billView = () => ({ id: createEntityId(), billId, supplierId, currency: "USD", kind: "credit", amountMinor: 20,
  externalDocumentId: input().externalDocumentId, evidenceReference: input().evidenceReference, occurredAt: at, reasonCode: input().reasonCode,
  procurementAdjustmentId: null, procurementReviewId: null, balanceAfter: balance(), recordedAt: at });
const paymentView = () => ({ id: createEntityId(), paymentId, supplierId, currency: "USD", kind: "refund", amountMinor: 20,
  externalDocumentId: input().externalDocumentId, evidenceReference: input().evidenceReference, occurredAt: at, reasonCode: input().reasonCode,
  evidenceStatus: "operator_recorded", balanceAfter: { amountMinor: 100, refundedMinor: 20, voidedMinor: 0, netAmountMinor: 80,
    allocatedMinor: 0, unallocatedMinor: 80, lifecycle: "active" }, recordedAt: at });
const context = (...path: string[]) => ({ params: Promise.resolve({ path }) });
const request = (path: string, body: unknown, origin = "http://localhost:3130") => new Request(`${prefix}/${path}`, {
  method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body),
});
beforeEach(() => { upstream.mockReset(); vi.stubEnv("API_BASE_URL", "http://127.0.0.1:8130"); });
afterEach(() => vi.unstubAllEnvs());

describe("payables correction proxy preserves actual targets, original keys and execution receipts", () => {
  it.each(["bills", "payments"] as const)("forwards one normalized %s adjustment with its original key and no caller-selected authority", async operation => {
    const id = operation === "bills" ? billId : paymentId, original = operation === "bills" ? input() : paidInput(), view = operation === "bills" ? billView() : paymentView();
    upstream.mockResolvedValue(Response.json(view, { status: 201 }));
    const response = await POST(request(`${operation}/${id}/adjustments`, original), context(operation, id, "adjustments"));
    expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(view); expect(upstream).toHaveBeenCalledOnce();
    const [url, init] = upstream.mock.calls[0]!; expect(url).toBe(`http://127.0.0.1:8130/v1/finance/payables/${operation}/${id}/adjustments`);
    expect(init.method).toBe("POST"); expect(init.cache).toBe("no-store"); expect(JSON.parse(init.body)).toEqual(original);
    expect(new Headers(init.headers).has("authorization")).toBe(false); expect(new Headers(init.headers).has("x-tenant-id")).toBe(false);
  });
  it("normalizes a date alias but preserves the exact original expected net, business evidence and request key", async () => {
    upstream.mockResolvedValue(Response.json(billView(), { status: 201 }));
    const response = await POST(request(`bills/${billId}/adjustments`, { ...input(), occurredAt: "2026-07-03T00:00:00Z" }), context("bills", billId, "adjustments"));
    expect(response.status).toBe(201); expect(JSON.parse(upstream.mock.calls[0]![1].body)).toEqual(input());
  });
  it("rejects cross-origin mutations, malformed targets and non-allowlisted actions before upstream I/O", async () => {
    expect((await POST(request(`bills/${billId}/adjustments`, input(), "http://elsewhere.test"), context("bills", billId, "adjustments"))).status).toBe(403);
    expect((await POST(request("bills/not-a-uuid/adjustments", input()), context("bills", "not-a-uuid", "adjustments"))).status).toBe(404);
    expect((await POST(request(`bills/${billId}/approve`, input()), context("bills", billId, "approve"))).status).toBe(404);
    expect((await GET(new Request(`${prefix}/bills/${billId}/adjustments`), context("bills", billId, "adjustments"))).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("rejects caller authority, source money overrides, null bodies and non-millisecond originals before I/O", async () => {
    for (const body of [null, { ...input(), tenantId: createEntityId() }, { ...input(), approvedBy: createEntityId() },
      { ...input(), occurredAt: "2026-07-03T00:00:00.0001Z" }, { ...sourceInput(), amountMinor: 20 }, { ...input(), amountMinor: 0.5 }])
      expect((await POST(request(`bills/${billId}/adjustments`, body), context("bills", billId, "adjustments"))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("preserves the streamed request bound and rejects a non-JSON correction without forwarding it", async () => {
    expect((await POST(request(`bills/${billId}/adjustments`, { ...input(), evidenceReference: "x".repeat(70_000) }), context("bills", billId, "adjustments"))).status).toBe(413);
    const nonJson = new Request(`${prefix}/payments/${paymentId}/adjustments`, { method: "POST", headers: { origin: "http://localhost:3130", "content-type": "text/plain" }, body: "synthetic" });
    expect((await POST(nonJson, context("payments", paymentId, "adjustments"))).status).toBe(415); expect(upstream).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 429, 503])("preserves HTTP %i and private caching while withholding backend private details", async status => {
    upstream.mockResolvedValue(Response.json({ message: "SYNTHETIC-PRIVATE-ACCOUNT-DETAILS", secret: "not-public" }, { status }));
    const response = await POST(request(`payments/${paymentId}/adjustments`, paidInput()), context("payments", paymentId, "adjustments"));
    expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).not.toContain("SYNTHETIC-PRIVATE"); expect(upstream).toHaveBeenCalledOnce();
  });
  it("preserves an explicit stale-balance conflict and never converts a rejected correction into a success", async () => {
    upstream.mockResolvedValue(Response.json({ code: "finance_payables_balance_changed", message: "SYNTHETIC-PRIVATE-ROW" }, { status: 409 }));
    const response = await POST(request(`bills/${billId}/adjustments`, input()), context("bills", billId, "adjustments"));
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ code: "finance_payables_balance_changed", message: "台账净额已变化 请刷新后按当前余额核对" });
    expect(upstream).toHaveBeenCalledOnce();
  });
  it("rejects a valid bill receipt belonging to another target or different original document", async () => {
    for (const changed of [{ billId: createEntityId() }, { externalDocumentId: "ANOTHER-DOCUMENT" }, { evidenceReference: "Other actual evidence" },
      { reasonCode: "OTHER_REASON" }, { occurredAt: "2026-07-04T00:00:00.000Z" }]) {
      upstream.mockResolvedValueOnce(Response.json({ ...billView(), ...changed }, { status: 201 }));
      const response = await POST(request(`bills/${billId}/adjustments`, input()), context("bills", billId, "adjustments"));
      expect(response.status).toBe(502); expect(await response.json()).toMatchObject({ code: "finance_payables_result_unconfirmed" });
    }
  });
  it("rejects different refund money or target even if the supplied current balance is internally conserved", async () => {
    for (const view of [{ ...paymentView(), paymentId: createEntityId() }, { ...paymentView(), amountMinor: 21,
      balanceAfter: { ...paymentView().balanceAfter, refundedMinor: 21, netAmountMinor: 79, unallocatedMinor: 79 } }]) {
      upstream.mockResolvedValueOnce(Response.json(view, { status: 201 }));
      expect((await POST(request(`payments/${paymentId}/adjustments`, paidInput()), context("payments", paymentId, "adjustments"))).status).toBe(502);
    }
  });
  it("accepts only the requested actual procurement record and approval pair", async () => {
    const value = { ...billView(), procurementAdjustmentId: recordId, procurementReviewId: reviewId, reasonCode: "PROCUREMENT_APPROVED" };
    upstream.mockResolvedValueOnce(Response.json(value, { status: 201 }));
    expect((await POST(request(`bills/${billId}/adjustments`, sourceInput()), context("bills", billId, "adjustments"))).status).toBe(201);
    for (const changed of [{ procurementAdjustmentId: createEntityId() }, { procurementReviewId: createEntityId() }, { reasonCode: "MANUAL_APPROVAL" }]) {
      upstream.mockResolvedValueOnce(Response.json({ ...value, ...changed }, { status: 201 }));
      expect((await POST(request(`bills/${billId}/adjustments`, sourceInput()), context("bills", billId, "adjustments"))).status).toBe(502);
    }
  });
  it("accepts a zero-money actual source acknowledgement while retaining its source IDs and original expected net", async () => {
    const value = { ...billView(), kind: "source_acknowledgement", amountMinor: 0, procurementAdjustmentId: recordId, procurementReviewId: reviewId,
      reasonCode: "PROCUREMENT_APPROVED", balanceAfter: { ...balance(), creditMinor: 0, netAmountMinor: 100, outstandingMinor: 100 } };
    upstream.mockResolvedValue(Response.json(value, { status: 201 }));
    const response = await POST(request(`bills/${billId}/adjustments`, sourceInput()), context("bills", billId, "adjustments"));
    expect(response.status).toBe(201); expect(await response.json()).toEqual(value); expect(JSON.parse(upstream.mock.calls[0]![1].body)).toEqual(sourceInput());
  });
  it("rejects a later current balance substituted for the immutable original execution receipt", async () => {
    upstream.mockResolvedValue(Response.json({ ...billView(), balanceAfter: { ...balance(), debitMinor: 5, netAmountMinor: 85, outstandingMinor: 85 } }, { status: 201 }));
    expect((await POST(request(`bills/${billId}/adjustments`, input()), context("bills", billId, "adjustments"))).status).toBe(502);
    const original = billView(); upstream.mockResolvedValue(Response.json(original, { status: 201 }));
    const response = await POST(request(`bills/${billId}/adjustments`, input()), context("bills", billId, "adjustments"));
    expect(response.status).toBe(201); expect(await response.json()).toEqual(original);
  });
  it("returns unknown outcome after one transport failure without retrying or leaking the thrown error", async () => {
    upstream.mockRejectedValue(new Error("SYNTHETIC-PRIVATE-PROVIDER-SECRET"));
    const response = await POST(request(`payments/${paymentId}/adjustments`, paidInput()), context("payments", paymentId, "adjustments"));
    expect(response.status).toBe(502); expect(response.headers.get("cache-control")).toBe("private, no-store");
    const text = await response.text(); expect(text).toContain("finance_payables_result_unconfirmed"); expect(text).not.toContain("SYNTHETIC-PRIVATE"); expect(upstream).toHaveBeenCalledOnce();
  });
});
