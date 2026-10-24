import { beforeEach, describe, expect, it, vi } from "vitest";
import { PrepareIncomingCommandSchema } from "@yummyai/contracts/procurement/incoming-command";
const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: apiFetchMock }));
import { GET, POST } from "./route";

const purchase = "019f0000-0000-7000-8000-000000000001", commandId = "019f0000-0000-7000-8000-000000000002", location = "019f0000-0000-7000-8000-000000000003";
const other = "019f0000-0000-7000-8000-000000000004", authority = "synthetic-personal-authority";
const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
const url = "http://web.test/api/incoming";
const original = PrepareIncomingCommandSchema.parse({ kind: "record_arrival", targetId: purchase, input: { code: "ARR-SYNTHETIC", expectedPurchaseOrderVersion: 1,
  arrivedAt: "2026-10-19T01:00:00Z", externalReference: "Synthetic handover", lines: [{ lineKey: "L1", quantity: "0.123456789", unit: "meter",
    holdingLocationId: location, lotCode: "原批号 Ab/2026", expiresAt: null }], idempotencyKey: "synthetic-arrival-key" } });
const row = { id: commandId, kind: original.kind, targetId: purchase, postingId: null, targetLabel: "Synthetic purchase", targetDetail: null,
  status: "prepared", createdAt: "2026-10-20T00:00:00.000Z", expiresAt: "2026-10-27T00:00:00.000Z", completedAt: null,
  contextAuthority: authority, acknowledged: false, canExecute: true, canCancel: true, original, result: null, blockReason: null };
const post = (body: unknown, origin = "http://web.test") => new Request(url, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("personal incoming BFF", () => {
  beforeEach(() => { apiFetchMock.mockReset(); process.env.API_BASE_URL = "http://api.test"; });
  it("rejects caller tenant selection, duplicate queries and bypass mutation paths", async () => {
    for (const query of [`?kind=record_arrival&targetId=${purchase}&tenantId=caller`, `?kind=record_arrival&kind=record_arrival&targetId=${purchase}`])
      expect((await GET(new Request(url + query), context(["commands"]))).status).toBe(400);
    expect((await POST(post(original), context(["orders", purchase, "arrivals"]))).status).toBe(404);
    expect((await POST(post({ ...original, tenantId: other }), context(["commands"]))).status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
  it("requires same-origin bounded input and never accepts a second execute body", async () => {
    expect((await POST(post(original, "http://outside.test"), context(["commands"]))).status).toBe(403);
    expect((await POST(post({ original }), context(["commands", commandId, "execute"]))).status).toBe(400);
    expect((await POST(post({ ...original, input: { ...original.input, externalReference: "x".repeat(270000) } }), context(["commands"]))).status).toBe(413);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
  it("forwards only normalized original input and preserves the actual supplier lot", async () => {
    apiFetchMock.mockResolvedValueOnce(Response.json(row, { status: 201 }));
    const response = await POST(post(original), context(["commands"]));
    expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(apiFetchMock.mock.lastCall?.[0]).toBe("http://api.test/v1/procurement/incoming/commands");
    expect(JSON.parse(apiFetchMock.mock.lastCall?.[1].body)).toEqual(original);
    expect(JSON.parse(apiFetchMock.mock.lastCall?.[1].body).input.lines[0].lotCode).toBe("原批号 Ab/2026");
    apiFetchMock.mockResolvedValueOnce(Response.json({ ...row, original: { ...original, input: { ...original.input, externalReference: "Different handover" } } }));
    expect((await POST(post(original), context(["commands"]))).status).toBe(502);
  });
  it("checks original ID, scope and authority consistency before exposing returned rows", async () => {
    apiFetchMock.mockResolvedValueOnce(Response.json({ items: [row], contextAuthority: authority }));
    expect((await GET(new Request(`${url}?kind=record_arrival&targetId=${purchase}`), context(["commands"]))).status).toBe(200);
    for (const result of [{ ...row, id: other }, { ...row, unexpectedPrivateField: "private" }]) {
      apiFetchMock.mockResolvedValueOnce(Response.json(result));
      expect((await GET(new Request(url), context(["commands", commandId]))).status).toBe(502);
    }
    apiFetchMock.mockResolvedValueOnce(Response.json({ purchaseOrderId: other, items: [], nextCursor: null, contextAuthority: authority }));
    expect((await GET(new Request(url), context(["orders", purchase, "commands"]))).status).toBe(502);
    apiFetchMock.mockResolvedValueOnce(Response.json({ items: [{ ...row, contextAuthority: "other-authority" }], contextAuthority: authority }));
    expect((await GET(new Request(`${url}?kind=record_arrival&targetId=${purchase}`), context(["commands"]))).status).toBe(502);
  });
  it("keeps a committed success on cancellation and treats an unknown outcome as unconfirmed", async () => {
    const succeeded = { ...row, status: "succeeded", canExecute: false, canCancel: false, completedAt: "2026-10-20T00:00:01.000Z", result: { kind: original.kind, id: other } };
    apiFetchMock.mockResolvedValueOnce(Response.json(succeeded));
    const response = await POST(post({}), context(["commands", commandId, "cancel"]));
    expect(response.status).toBe(200); expect((await response.json()).result).toEqual(succeeded.result);
    expect(JSON.parse(apiFetchMock.mock.lastCall?.[1].body)).toEqual({});
    apiFetchMock.mockRejectedValueOnce(new Error("Synthetic private transport detail"));
    const unknown = await POST(post({}), context(["commands", commandId, "execute"]));
    expect(unknown.status).toBe(502); const body = await unknown.text();
    expect(body).toContain("incoming_result_unconfirmed"); expect(body).not.toContain("Synthetic private");
  });
});
