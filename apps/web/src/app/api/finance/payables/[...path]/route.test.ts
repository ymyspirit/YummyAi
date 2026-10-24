import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEntityId } from "@yummyai/contracts";
const upstream = vi.hoisted(() => vi.fn());
vi.mock("../../../../../server-api", () => ({ apiFetch: upstream }));
import { GET, POST } from "./route";

const supplierId = createEntityId(), paymentId = createEntityId(), billId = createEntityId(), batchId = createEntityId();
const payment = { supplierId, externalPaymentId: "SYNTHETIC-PAY", currency: "KWD", amountMinor: 1234,
  paidAt: "2026-07-02T00:00:00.000Z", method: "bank_transfer", evidenceReference: "SYNTHETIC-REF", idempotencyKey: "synthetic-original-key" };
const view = () => { const { idempotencyKey: unused, ...value } = payment; void unused;
  return { ...value, id: paymentId, evidenceStatus: "operator_recorded", allocatedMinor: 0, unallocatedMinor: 1234,
    refundedMinor: 0, voidedMinor: 0, netAmountMinor: 1234, lifecycle: "active", status: "unallocated", recordedAt: payment.paidAt }; };
const context = (...path: string[]) => ({ params: Promise.resolve({ path }) });
const request = (body: unknown, origin = "http://localhost:3130", suffix = "payments") => new Request(`http://localhost:3130/api/finance/payables/${suffix}`, {
  method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body),
});
beforeEach(() => { upstream.mockReset(); process.env.API_BASE_URL = "http://127.0.0.1:8130"; });

describe("payables personal proxy preserves original operation and safe results", () => {
  it("forwards normalized original evidence without caller-selected tenant or authorization", async () => {
    upstream.mockResolvedValue(Response.json(view(), { status: 201 }));
    const response = await POST(request(payment), context("payments"));
    expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("private, no-store");
    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8130/v1/finance/payables/payments"); expect(JSON.parse(init.body)).toEqual(payment);
    expect(new Headers(init.headers).has("authorization")).toBe(false); expect(await response.json()).toEqual(view());
  });
  it("rejects cross-origin writes and non-allowlisted routes before upstream I/O", async () => {
    expect((await POST(request(payment, "http://elsewhere.test"), context("payments"))).status).toBe(403);
    expect((await POST(request(payment), context("payments", paymentId, "transfer"))).status).toBe(404);
    expect((await GET(new Request("http://localhost:3130/api/finance/payables/workspace?tenantId=anything"), context("workspace"))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("rejects raw authority, unknown currency and over-precision original transport", async () => {
    for (const body of [{ ...payment, tenantId: createEntityId() }, { ...payment, currency: "ZZZ" }, { ...payment, amountMinor: 1.5 }])
      expect((await POST(request(body), context("payments"))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("enforces the streaming body limit without trusting Content-Length", async () => {
    const response = await POST(request({ ...payment, evidenceReference: "x".repeat(70_000) }), context("payments"));
    expect(response.status).toBe(413); expect(upstream).not.toHaveBeenCalled();
  });
  it("rejects a structurally valid payment response for different original evidence", async () => {
    upstream.mockResolvedValue(Response.json({ ...view(), supplierId: createEntityId() }));
    const response = await POST(request(payment), context("payments"));
    expect(response.status).toBe(502); expect(await response.json()).toMatchObject({ code: "finance_payables_result_unconfirmed" });
  });
  it("binds a successful allocation result to every original bill and exact amount", async () => {
    const body = { paymentId, allocations: [{ billId, amountMinor: 1000 }], idempotencyKey: "synthetic-allocation-original" };
    upstream.mockResolvedValue(Response.json({ id: batchId, paymentId, recordedAt: payment.paidAt, allocations: [{ id: createEntityId(), batchId,
      paymentId, billId, supplierId, currency: "KWD", amountMinor: 999, released: false, recordedAt: payment.paidAt }] }));
    expect((await POST(request(body, undefined, "allocations"), context("allocations"))).status).toBe(502);
  });
  it("binds releases to their original allocation path and reason", async () => {
    const target = createEntityId(), body = { reasonCode: "WRONG_BILL", idempotencyKey: "synthetic-release-original" };
    upstream.mockResolvedValue(Response.json({ id: createEntityId(), allocationId: createEntityId(), reasonCode: "WRONG_BILL", recordedAt: payment.paidAt }));
    expect((await POST(request(body, undefined, `allocations/${target}/releases`), context("allocations", target, "releases"))).status).toBe(502);
  });
  it("preserves current permission failure and never forwards raw backend details", async () => {
    upstream.mockResolvedValue(Response.json({ message: "SYNTHETIC-PRIVATE-INTERNAL", stack: "not public" }, { status: 403 }));
    const response = await GET(new Request("http://localhost:3130/api/finance/payables/workspace"), context("workspace"));
    expect(response.status).toBe(403); expect(await response.text()).not.toContain("SYNTHETIC-PRIVATE");
  });
  it("returns unknown outcome after network failure without fabricating a successful payment", async () => {
    upstream.mockRejectedValue(new Error("SYNTHETIC-PRIVATE-NETWORK"));
    const response = await POST(request(payment), context("payments"));
    expect(response.status).toBe(502); const text = await response.text();
    expect(text).toContain("finance_payables_result_unconfirmed"); expect(text).not.toContain("SYNTHETIC-PRIVATE");
  });
});
