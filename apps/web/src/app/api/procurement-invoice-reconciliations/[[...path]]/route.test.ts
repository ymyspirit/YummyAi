import { beforeEach, describe, expect, it, vi } from "vitest";
const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: apiFetchMock }));
import { GET } from "./route";

const id = "019f0000-0000-7000-8000-000000000001", po = "019f0000-0000-7000-8000-000000000002";
const item = { invoiceId: id, invoiceNumber: "SYNTHETIC-REFERENCE", purchaseOrderId: po, purchaseOrderCode: "SYNTHETIC-PO",
  originalStatus: "reconciliation_required", status: "unknown", currency: "EUR", netAmountMinor: 120, varianceMinor: null, pendingCount: 1 };
const detail = { invoiceId: id, invoiceNumber: item.invoiceNumber, purchaseOrderId: po, purchaseOrderCode: item.purchaseOrderCode,
  purchaseOrderVersionId: null, supplierId: po, originalStatus: item.originalStatus, originalProofId: null, fingerprint: "a".repeat(64),
  canRecord: false, canApprove: false, blockReason: "缺少原依据", adjustments: [], events: [], receipts: [],
  balance: { status: "unknown", currency: "EUR", comparisonCurrency: null, unknownReasons: ["legacy_basis_missing"], netAmountMinor: 120, varianceMinor: null,
    lines: [{ invoiceLineId: id, lineKey: "L1", unit: null, originalQuantity: 1, creditedQuantity: 0, netQuantity: 1,
      allocatedQuantity: null, unallocatedQuantity: null, originalAmountMinor: null, creditAmountMinor: 0, debitAmountMinor: 0,
      netAmountMinor: null, expectedAmountMinor: null, varianceMinor: null }] } };
const context = (path: string[] = []) => ({ params: Promise.resolve({ path }) });
const request = (suffix = "") => new Request(`http://web.test/api/procurement-invoice-reconciliations${suffix}`);
describe("authorized invoice reconciliation read BFF", () => {
  beforeEach(() => { apiFetchMock.mockReset(); process.env.API_BASE_URL = "http://api.test"; });
  it("rejects caller identity, duplicated filters, invalid IDs and detail queries before authentication forwarding", async () => {
    for (const [suffix, path] of [["?tenantId=" + id, []], ["?pendingOnly=true&pendingOnly=false", []], ["/bad", ["bad"]], [`/${id}?before=${po}`, [id]], ["/a/b", [id, po]]] as const)
      expect((await GET(request(suffix), context([...path]))).status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
  it("uses the personal authenticated API with no caching and preserves the authoritative cursor", async () => {
    apiFetchMock.mockResolvedValueOnce(Response.json({ items: [item], nextCursor: id, unavailableCount: 2 }));
    const response = await GET(request(`?purchaseOrderId=${po}&pendingOnly=true`), context());
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await response.json()).nextCursor).toBe(id);
    expect(apiFetchMock.mock.lastCall?.[0]).toBe(`http://api.test/v1/procurement/invoice-reconciliations?purchaseOrderId=${po}&pendingOnly=true`);
  });
  it("rejects a different PO or an unfiltered pending result", async () => {
    for (const value of [{ ...item, purchaseOrderId: id }, { ...item, pendingCount: 0 }]) {
      apiFetchMock.mockResolvedValueOnce(Response.json({ items: [value], nextCursor: null, unavailableCount: 0 }));
      expect((await GET(request(`?purchaseOrderId=${po}&pendingOnly=true`), context())).status).toBe(502);
    }
  });
  it("reads the exact invoice and preserves unknown values without supplying a missing unit or price", async () => {
    apiFetchMock.mockResolvedValueOnce(Response.json(detail));
    const response = await GET(request(`/${id}`), context([id]));
    expect(response.status).toBe(200); expect((await response.json()).balance.lines[0].unit).toBeNull();
    apiFetchMock.mockResolvedValueOnce(Response.json({ ...detail, invoiceId: po }));
    expect((await GET(request(`/${id}`), context([id]))).status).toBe(502);
  });
  it.each([401, 403, 404])("keeps current authorization failure %s private", async status => {
    apiFetchMock.mockResolvedValueOnce(new Response(null, { status }));
    const response = await GET(request(), context()); expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("returns an explicit unavailable state for malformed or interrupted upstream results", async () => {
    apiFetchMock.mockResolvedValueOnce(Response.json({ items: [] })); expect((await GET(request(), context())).status).toBe(502);
    apiFetchMock.mockRejectedValueOnce(new Error("synthetic disconnect")); expect((await GET(request(), context())).status).toBe(502);
  });
});
