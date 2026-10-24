import { beforeEach, describe, expect, it, vi } from "vitest";
const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: apiFetchMock }));
import { GET, POST } from "./route";

const id = "019f0000-0000-7000-8000-000000000001", po = "019f0000-0000-7000-8000-000000000002";
const invoiceId = "019f0000-0000-7000-8000-000000000003";
const original = { kind: "invoice_record", targetId: po, input: { expectedVersion: 1, invoiceNumber: "SYNTHETIC-INVOICE-COMMAND",
  currency: "USD", issuedAt: "2026-10-20T00:00:00Z", lines: [{ lineKey: "L1", invoicedQuantity: "0.1", unitCostMinor: 1200, priceBasisQuantity: 1 }], idempotencyKey: "synthetic-original-invoice" } };
const prepared = { id, kind: "invoice_record", targetId: po, targetLabel: "SYNTHETIC-PO", targetDetail: null, status: "prepared",
  createdAt: "2026-10-20T00:00:00Z", expiresAt: "2026-10-27T00:00:00Z", completedAt: null, contextAuthority: "synthetic-authority",
  acknowledged: false, canExecute: true, canCancel: true, original, result: null, reviewBasis: null, invoiceResult: null, blockReason: null };
const invoice = { id: invoiceId, purchaseOrderId: po, invoiceNumber: original.input.invoiceNumber, currency: "USD", comparisonCurrency: "USD",
  totalMinor: 120, varianceMinor: 0, status: "matched", allocationStatus: "complete", issuedAt: original.input.issuedAt, createdAt: prepared.createdAt,
  lines: [{ lineKey: "L1", invoicedQuantity: "0.1", unit: "kilogram", unitCostMinor: 1200, priceBasisQuantity: 1, allocatedQuantity: "0.1", varianceMinor: 0 }] };
const succeeded = { ...prepared, status: "succeeded", canExecute: false, canCancel: false, completedAt: prepared.createdAt,
  result: { kind: "invoice_record", id: invoiceId, versionId: null, version: null }, invoiceResult: invoice };
const context = (path = ["commands"]) => ({ params: Promise.resolve({ path }) });
const request = (body: unknown = original, path = "commands", origin = "http://web.test") => new Request("http://web.test/api/procurement-commands/" + path,
  { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("personal invoice original command BFF", () => {
  beforeEach(() => { apiFetchMock.mockReset(); process.env.API_BASE_URL = "http://api.test"; });
  it("requires a fixed version, strict input, same origin and bounded payload", async () => {
    expect((await POST(request(original, "commands", "http://outside.test"), context())).status).toBe(403);
    expect((await POST(request({ ...original, input: { ...original.input, expectedVersion: undefined } }), context())).status).toBe(400);
    expect((await POST(request({ ...original, tenantId: id }), context())).status).toBe(400);
    expect((await POST(request({ ...original, input: { ...original.input, invoiceNumber: "x".repeat(270000) } }), context())).status).toBe(413);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
  it("forwards the original fixed precision body through personal apiFetch", async () => {
    apiFetchMock.mockResolvedValueOnce(Response.json(prepared, { status: 201 }));
    const response = await POST(request(), context()); expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(apiFetchMock.mock.lastCall?.[0]).toBe("http://api.test/v1/procurement/commands");
    expect(JSON.parse(apiFetchMock.mock.lastCall?.[1].body)).toEqual(original);
  });
  it("rejects another original, target or actual invoice result", async () => {
    for (const view of [{ ...prepared, original: { ...original, input: { ...original.input, invoiceNumber: "CHANGED" } } },
      { ...prepared, targetId: id }, { ...succeeded, invoiceResult: null },
      { ...succeeded, invoiceResult: { ...invoice, purchaseOrderId: id } },
      { ...succeeded, result: { ...succeeded.result, versionId: po, version: 1 } }]) {
      apiFetchMock.mockResolvedValueOnce(Response.json(view));
      expect((await POST(request(), context())).status).toBe(502);
    }
  });
  it("reads the real result by original ID and acknowledges without a new input", async () => {
    apiFetchMock.mockResolvedValueOnce(Response.json(succeeded));
    const result = await GET(new Request(`http://web.test/api/procurement-commands/commands/${id}`), context(["commands", id]));
    expect((await result.json()).invoiceResult).toEqual(invoice);
    apiFetchMock.mockResolvedValueOnce(Response.json({ ...succeeded, original: null, acknowledged: true }));
    expect((await POST(request({}, `commands/${id}/acknowledge`), context(["commands", id, "acknowledge"]))).status).toBe(200);
    expect((await POST(request(original, `commands/${id}/execute`), context(["commands", id, "execute"]))).status).toBe(400);
  });
  it("rejects mixed recovery scope and caller supplied query identity", async () => {
    apiFetchMock.mockResolvedValueOnce(Response.json({ items: [prepared], nextCursor: null, unavailableCount: 0, contextAuthority: "changed" }));
    expect((await GET(new Request(`http://web.test/api/procurement-commands/commands?kind=invoice_record&targetId=${po}`), context())).status).toBe(502);
    expect((await GET(new Request("http://web.test/api/procurement-commands/commands?tenantId=caller"), context())).status).toBe(400);
  });
  it("preserves login failures and unknown outcomes without echoing transport secrets", async () => {
    for (const status of [401, 403, 409]) { apiFetchMock.mockResolvedValueOnce(Response.json({ code: "procurement_original_mismatch" }, { status }));
      expect((await POST(request(), context())).status).toBe(status); }
    apiFetchMock.mockRejectedValueOnce(new Error("synthetic-private-transport"));
    const response = await POST(request(), context()); expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("synthetic-private");
  });
});
