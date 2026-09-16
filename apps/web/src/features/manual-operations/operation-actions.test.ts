import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveOperation } from "./operation-actions";
import { moneyMinor } from "./operation-types";

const api = vi.hoisted(() => vi.fn());
vi.mock("../../server-api", () => ({ apiFetch: api }));
const id = "019f7600-0000-7000-8000-000000000701";

describe("manual business operations", () => {
  beforeEach(() => { api.mockReset(); vi.stubEnv("API_BASE_URL", "http://api.test"); });
  it("rejects invalid bodies and unknown operations before contacting the API", async () => {
    expect((await saveOperation("warehouse.create", { name: "Name" })).ok).toBe(false);
    expect((await saveOperation("stock.update", { name: "Name" }, "../../suppliers")).ok).toBe(false);
    expect((await saveOperation("constructor" as never, {})).ok).toBe(false);
    expect(api).not.toHaveBeenCalled();
  });
  it("redacts raw tenant and credential fields from successful legacy API responses", async () => {
    api.mockResolvedValue(Response.json({ id, name: "供应商", kind: "manual", tenantId: "secret-tenant", externalConnectionRef: "secret-ref", createdBy: "private-user" }));
    const result = await saveOperation("supplier.create", { name: "供应商", kind: "manual", regionCode: "CN", settlementCurrency: "CNY" });
    expect(result).toMatchObject({ ok: true, record: { id, name: "供应商", kind: "manual" } });
    expect(JSON.stringify(result)).not.toMatch(/secret|private|tenantId|createdBy/);
  });
  it("keeps a permission denial explicit instead of claiming the record was saved", async () => {
    api.mockResolvedValue(Response.json({ detail: "Forbidden" }, { status: 403 }));
    expect(await saveOperation("stock.update", { name: "物料" }, id)).toMatchObject({ ok: false, message: expect.stringContaining("权限") });
  });
  it("preserves the supplied idempotency key on inventory retry", async () => {
    api.mockResolvedValue(Response.json({ id }));
    const input = { stockItemId: id, locationId: id, lotId: null, bucket: "physical", type: "opening", quantityDelta: 2, unit: "each", sourceType: "opening", sourceId: "首次盘点", reasonCode: "MANUAL_OPENING", occurredAt: "2026-09-12T00:00:00Z", idempotencyKey: "same-request-0001" };
    await saveOperation("movement.create", input); await saveOperation("movement.create", input);
    expect(api.mock.calls.map((call) => JSON.parse(call[1].body).idempotencyKey)).toEqual([input.idempotencyKey, input.idempotencyKey]);
  });
  it("converts decimal money exactly and rejects rounding or negative amounts", () => {
    expect(moneyMinor("1.15")).toBe(115); expect(moneyMinor("12.3")).toBe(1230);
    for (const amount of ["", "0.001", "-1", "Infinity", "1e3"]) expect(() => moneyMinor(amount)).toThrow();
  });
});
