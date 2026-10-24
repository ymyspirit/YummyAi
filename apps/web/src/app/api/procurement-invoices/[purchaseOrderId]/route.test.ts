import { beforeEach, describe, expect, it, vi } from "vitest";
const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: apiFetchMock }));
import { POST } from "./route";

const purchaseOrderId = "019f0000-0000-7000-8000-000000000001", invoiceId = "019f0000-0000-7000-8000-000000000002";
const context = { params: Promise.resolve({ purchaseOrderId }) }, url = `http://web.test/api/procurement-invoices/${purchaseOrderId}`;
const input = { invoiceNumber: "SYNTHETIC-PARTIAL", currency: "USD", expectedVersion: 1, issuedAt: "2026-10-20T00:00:00Z",
  lines: [{ lineKey: "L1", invoicedQuantity: "0.1", unitCostMinor: 1200, priceBasisQuantity: 1 }], idempotencyKey: "synthetic-invoice-original" };
const view = { id: invoiceId, purchaseOrderId, invoiceNumber: input.invoiceNumber, currency: "USD", comparisonCurrency: "USD", totalMinor: 120,
  varianceMinor: 0, status: "matched", allocationStatus: "complete", issuedAt: "2026-10-20T00:00:00.000Z", createdAt: "2026-10-20T00:00:01.000Z" };
const request = (body: unknown = input, origin = "http://web.test", query = "") => new Request(url + query, { method: "POST",
  headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("personal procurement invoice BFF", () => {
  beforeEach(() => { apiFetchMock.mockReset(); process.env.API_BASE_URL = "http://api.test"; });
  it("requires same origin, bounded strict input and no caller tenant selection", async () => {
    expect((await POST(request(input, "http://outside.test"), context)).status).toBe(403);
    expect((await POST(request({ ...input, tenantId: invoiceId }), context)).status).toBe(400);
    expect((await POST(request(input, undefined, "?tenantId=caller"), context)).status).toBe(400);
    expect((await POST(request({ ...input, invoiceNumber: "x".repeat(270000) }), context)).status).toBe(413);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
  it("forwards a fixed decimal original via personal apiFetch and returns its verified result", async () => {
    apiFetchMock.mockResolvedValueOnce(Response.json(view, { status: 201 }));
    const response = await POST(request(), context);
    expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(apiFetchMock.mock.lastCall?.[0]).toBe(`http://api.test/v1/procurement/purchase-orders/${purchaseOrderId}/invoices`);
    expect(JSON.parse(apiFetchMock.mock.lastCall?.[1].body)).toEqual(input);
    expect((await response.json()).id).toBe(invoiceId);
  });
  it("preserves unauthorized and original mismatch responses without exposing private transport errors", async () => {
    for (const status of [401, 403, 409]) {
      apiFetchMock.mockResolvedValueOnce(Response.json({ code: "procurement_invoice_input_mismatch", message: "原填写不一致" }, { status }));
      expect((await POST(request(), context)).status).toBe(status);
    }
    apiFetchMock.mockRejectedValueOnce(new Error("synthetic private credential detail"));
    const response = await POST(request(), context); expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("private credential");
  });
  it("rejects another order, altered amount or an unbounded upstream response shape", async () => {
    for (const result of [{ ...view, purchaseOrderId: invoiceId }, { ...view, totalMinor: 121 }, { ...view, privateInput: "not public" }]) {
      apiFetchMock.mockResolvedValueOnce(Response.json(result)); expect((await POST(request(), context)).status).toBe(502);
    }
  });
});
