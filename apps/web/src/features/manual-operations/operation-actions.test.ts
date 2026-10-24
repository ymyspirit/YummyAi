import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveOperation, loadStockClassificationHistory } from "./operation-actions";
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
  it("sends partial supplier information to the API without requiring city, street or a full contact", async () => {
    api.mockResolvedValue(Response.json({ id, name: "Synthetic partial supplier", kind: "manual" }));
    const result = await saveOperation("supplier.create", { name: "Synthetic partial supplier", kind: "manual", settlementCurrency: "CNY", profile: { officeAddress: { province: "Synthetic province" }, contacts: [{ role: "business", name: "Synthetic contact" }] } });
    expect(result.ok).toBe(true);
    expect(JSON.parse(api.mock.calls[0]![1].body)).toMatchObject({ regionCode: "", profile: { officeAddress: { province: "Synthetic province", countryCode: "", city: "", street: "" }, contacts: [{ name: "Synthetic contact", phone: "", wechat: "", email: "" }] } });
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
  it("binds classification receipts to the original stock, kind and expected revision and keeps current stock after replay", async () => {
    const classification = { id: "019f7600-0000-7000-8000-000000000702", kind: "material", versionNumber: 1, recordedAt: "2026-10-20T00:00:00Z" };
    const stockItem = { id, code: "SYNTHETIC", name: "Synthetic stock", skuId: null, baseUnit: "meter", status: "active", classification: { ...classification, kind: "packaging", versionNumber: 2 }, tenantId: "private-tenant", createdBy: "private-actor" };
    const input = { expectedVersion: 0, kind: "material", reason: "Synthetic checked basis", idempotencyKey: "classification-request-1" };
    api.mockResolvedValue(Response.json({ stockItem, classification, replayed: true }));
    const result = await saveOperation("stock.classify", input, id);
    expect(result).toMatchObject({ ok: true, record: { id, classification: { kind: "packaging", versionNumber: 2 } } });
    expect(JSON.stringify(result)).not.toMatch(/private-|tenantId|createdBy/);
    for (const wrong of [{ stockItem: { ...stockItem, id: classification.id }, classification }, { stockItem, classification: { ...classification, kind: "blank" } }, { stockItem, classification: { ...classification, versionNumber: 2 } }]) {
      api.mockResolvedValue(Response.json({ ...wrong, replayed: false }));
      expect((await saveOperation("stock.classify", input, id)).ok).toBe(false);
    }
  });
  it("separates classification read denial from a temporary failure and rejects another stock's history", async () => {
    api.mockResolvedValue(Response.json({}, { status: 403 })); expect(await loadStockClassificationHistory(id)).toMatchObject({ data: null, denied: true });
    api.mockRejectedValue(new Error("Synthetic offline")); expect(await loadStockClassificationHistory(id)).toMatchObject({ data: null, denied: false });
    api.mockResolvedValue(Response.json({ stockItem: { id: "019f7600-0000-7000-8000-000000000702", code: "OTHER", name: "Synthetic", skuId: null, baseUnit: "meter", status: "active", classification: null }, canClassify: false, items: [], nextVersion: null }));
    expect(await loadStockClassificationHistory(id)).toMatchObject({ data: null, denied: true });
  });
  it("marks classification submission access loss separately from conflicts and unknown transport results", async () => {
    const input = { expectedVersion: 0, kind: "blank", reason: "Synthetic original basis", idempotencyKey: "classification-denial-request" };
    for (const status of [401, 403, 404]) {
      api.mockResolvedValue(Response.json({}, { status }));
      expect(await saveOperation("stock.classify", input, id)).toMatchObject({ ok: false, denied: true });
    }
    api.mockResolvedValue(Response.json({ code: "authority_changed" }, { status: 409 }));
    expect(await saveOperation("stock.classify", input, id)).toMatchObject({ ok: false, denied: true });
    api.mockResolvedValue(Response.json({}, { status: 409 }));
    expect(await saveOperation("stock.classify", input, id)).not.toHaveProperty("denied");
    api.mockRejectedValue(new Error("Synthetic response unknown"));
    expect(await saveOperation("stock.classify", input, id)).not.toHaveProperty("denied");
  });
});
