import { beforeEach, describe, expect, it, vi } from "vitest";
const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: apiFetchMock }));
import { GET, POST } from "./route";

const production = "019f0000-0000-7000-8000-000000000001", binding = "019f0000-0000-7000-8000-000000000002", other = "019f0000-0000-7000-8000-000000000003";
const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
const key = "synthetic-original-material-key", authority = "synthetic-member-authority";
const url = `http://web.test/api/production-materials/${production}`;
const command = { bindingId: binding, materialCode: "FABRIC", expectedProductionRevision: 1, contextAuthority: authority,
  idempotencyKey: key, occurredAt: "2026-10-20T00:00:00.000Z", reason: null, kind: "consume", quantity: "0.35",
  locationId: other, lotId: null, reservationEntryId: null, actualConfirmed: true };
const entry = { id: other, bindingId: binding, productionOrderId: production, materialCode: "FABRIC", kind: "consume", quantity: "0.35", unit: "meter",
  reservationId: null, movementId: other, originalEntryId: null, locationId: other, lotId: null, remainingReservedQuantity: null,
  locationName: "Synthetic bin", warehouseName: "Synthetic warehouse", lotCode: null, correctableQuantity: "0.35",
  reportReference: null, reason: null, idempotencyKey: key, createdBy: other, occurredAt: command.occurredAt, recordedAt: command.occurredAt };
const workspace = { contextAuthority: authority, productionOrderId: production, productionRevision: 1, productionStatus: "planned", bindingId: binding,
  sourceContentChecksum: "a".repeat(64), currentBinding: true, canWrite: true, diagnostics: [], nextCursor: null, lines: [], entries: [entry] };
const post = (body: unknown = command, origin = "http://web.test") => new Request(url, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("production materials BFF", () => {
  beforeEach(() => { apiFetchMock.mockReset(); process.env.API_BASE_URL = "http://api.test"; });
  it("rejects unknown paths, duplicate queries and caller tenant selection before forwarding", async () => {
    expect((await GET(new Request(url), context(["not-a-production"])) ).status).toBe(404);
    for (const query of ["?tenantId=caller", `?bindingId=${binding}&bindingId=${binding}`, "?beforeId=bad"])
      expect((await GET(new Request(url + query), context([production]))).status).toBe(400);
    expect((await GET(new Request(url), context([production, "publish"])) ).status).toBe(404);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
  it("requires same-origin exact, explicitly confirmed stock input", async () => {
    expect((await POST(post(command, "http://outside.test"), context([production]))).status).toBe(403);
    for (const body of [{ ...command, quantity: 0.35 }, { ...command, actualConfirmed: false }, { ...command, stockItemId: other }, { ...command, contextAuthority: undefined }])
      expect((await POST(post(body), context([production]))).status).toBe(400);
    expect((await POST(post({ ...command, reason: "x".repeat(17_000) }), context([production]))).status).toBe(413);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
  it("validates the returned production and binding on reads", async () => {
    apiFetchMock.mockResolvedValueOnce(Response.json(workspace));
    const response = await GET(new Request(`${url}?bindingId=${binding.toUpperCase()}`), context([production.toUpperCase()]));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(apiFetchMock.mock.lastCall?.[0]).toBe(`http://api.test/v1/production-orders/${production}/materials?bindingId=${binding.toUpperCase()}`);
    for (const value of [{ ...workspace, productionOrderId: other }, { ...workspace, entries: [{ ...entry, bindingId: other }] }]) {
      apiFetchMock.mockResolvedValueOnce(Response.json(value));
      expect((await GET(new Request(url), context([production]))).status).toBe(502);
    }
  });
  it("verifies exact original body and quantity on write receipts", async () => {
    apiFetchMock.mockResolvedValueOnce(Response.json({ entry, replayed: false, contextAuthority: authority }, { status: 201 }));
    const saved = await POST(post(), context([production])); expect(saved.status).toBe(201);
    expect(JSON.parse(String(apiFetchMock.mock.lastCall?.[1]?.body))).toEqual(command);
    for (const value of [{ ...entry, quantity: "0.36" }, { ...entry, idempotencyKey: "another-original-key" }, { ...entry, originalEntryId: other }]) {
      apiFetchMock.mockResolvedValueOnce(Response.json({ entry: value, replayed: true, contextAuthority: authority }));
      expect((await POST(post(), context([production]))).status).toBe(502);
    }
  });
  it("recovers only the requested original receipt and retains authority-change diagnostics", async () => {
    apiFetchMock.mockResolvedValueOnce(Response.json({ ...entry, contextAuthority: authority }));
    expect((await GET(new Request(url + "/receipts/" + key), context([production, "receipts", key]))).status).toBe(200);
    apiFetchMock.mockResolvedValueOnce(Response.json({ ...entry, idempotencyKey: "another-original-key", contextAuthority: authority }));
    expect((await GET(new Request(url + "/receipts/" + key), context([production, "receipts", key]))).status).toBe(502);
    apiFetchMock.mockResolvedValueOnce(Response.json({ code: "authority_changed", message: "Synthetic authority changed" }, { status: 409 }));
    const response = await POST(post(), context([production])); expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("authority_changed");
  });
  it("returns an unconfirmed result on transport failure without retrying a write", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("Synthetic disconnected response"));
    const response = await POST(post(), context([production])); expect(response.status).toBe(502);
    expect((await response.json()).code).toBe("material_result_unconfirmed");
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });
  it("persists only the exact original command and recovers the same scoped result", async () => {
    const prepared = { id: other, productionOrderId: production, bindingId: binding, requestKey: key, status: "prepared", contextAuthority: authority,
      createdAt: command.occurredAt, expiresAt: "2026-10-27T00:00:00.000Z", acknowledged: false, canExecute: true, canCancel: true, input: command, receipt: null, errorCode: null };
    apiFetchMock.mockResolvedValueOnce(Response.json(prepared, { status: 201 }));
    expect((await POST(post(), context([production, "commands"]))).status).toBe(201);
    apiFetchMock.mockResolvedValueOnce(Response.json({ items: [prepared], contextAuthority: authority }));
    expect((await GET(new Request(url + "/commands"), context([production, "commands"]))).status).toBe(200);
    apiFetchMock.mockResolvedValueOnce(Response.json({ ...prepared, input: { ...command, quantity: "0.36" } }));
    expect((await POST(post(), context([production, "commands"]))).status).toBe(502);
    const committed = { ...prepared, status: "succeeded", canExecute: false, canCancel: false, receipt: entry };
    apiFetchMock.mockResolvedValueOnce(Response.json(committed));
    expect((await POST(post({}), context([production, "commands", other, "cancel"]))).status).toBe(200);
    apiFetchMock.mockResolvedValueOnce(Response.json({ ...committed, receipt: { ...entry, idempotencyKey: "wrong-original-key" } }));
    expect((await GET(new Request(url), context([production, "commands", other]))).status).toBe(502);
  });
  it("rejects an edited recovery action and never retries an unknown write result", async () => {
    expect((await POST(post({ quantity: "0.1" }), context([production, "commands", other, "execute"]))).status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
    apiFetchMock.mockRejectedValueOnce(new Error("Synthetic lost original command response"));
    const result = await POST(post({}), context([production, "commands", other, "execute"]));
    expect(result.status).toBe(502); expect((await result.json()).code).toBe("material_result_unconfirmed"); expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });
  it("keeps paged stock selection scoped to the original material and validates receipt entry reads", async () => {
    const dimension = `${production}:${other}:-`, stock = { dimensionKey: dimension, stockItemId: production, unit: "meter", locationId: other, locationName: "Synthetic bin", warehouseName: "Synthetic warehouse", lotId: null, lotCode: null, availableQuantity: "0.123456789", physicalQuantity: 1, reservedQuantity: "0.876543211", expiresAt: null };
    const page = { productionOrderId: production, bindingId: binding, materialCode: "FABRIC", stockItemId: production, unit: "meter", contextAuthority: authority, items: [], selected: [stock], nextCursor: null };
    const request = () => new Request(`${url}/stock-options?bindingId=${binding}&materialCode=FABRIC&selected=${encodeURIComponent(dimension)}`);
    apiFetchMock.mockResolvedValueOnce(Response.json(page));
    expect((await GET(request(), context([production, "stock-options"]))).status).toBe(200);
    apiFetchMock.mockResolvedValueOnce(Response.json({ ...page, selected: [{ ...stock, stockItemId: other }] }));
    expect((await GET(request(), context([production, "stock-options"]))).status).toBe(502);
    apiFetchMock.mockResolvedValueOnce(Response.json({ ...entry, contextAuthority: authority }));
    expect((await GET(new Request(url), context([production, "entries", other]))).status).toBe(200);
    apiFetchMock.mockResolvedValueOnce(Response.json({ ...entry, id: binding, contextAuthority: authority }));
    expect((await GET(new Request(url), context([production, "entries", other]))).status).toBe(502);
    apiFetchMock.mockResolvedValueOnce(Response.json({ code: "authority_changed" }, { status: 409 }));
    const changed = await GET(request(), context([production, "stock-options"]));
    expect(changed.status).toBe(409); expect((await changed.json()).code).toBe("authority_changed");
  });
});
