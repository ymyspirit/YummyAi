import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { loadFactoryDirectory, loadFactoryHistory, saveOperation } from "./operation-actions";
import { FactoryCapabilityProfileSchema } from "@yummyai/contracts/suppliers/factory-directory";

const api = vi.hoisted(() => vi.fn());
vi.mock("../../server-api", () => ({ apiFetch: api }));
const id = "019f7600-0000-7000-8000-000000000701", other = "019f7600-0000-7000-8000-000000000702";
const contextAuthority = erpSessionAuthority({ tenantId: id, userId: other, permissions: ["order:read"], dataScope: "tenant", permissionScopes: { "order:read": "tenant" } });
const envelope = { contextAuthority, access: { canRead: true, canWrite: false }, factories: [], capabilities: [] };
const input = { supplierId: id, code: "SYNTHETIC", idempotencyKey: "12345678-1234-4234-8234-123456789012", profile: {
  name: "Synthetic draft", ownership: "partner", cooperationMode: "direct", status: "draft", productionAddress: null, pickupAddress: null, returnAddress: null,
  contacts: [], timeZone: null, workingHours: "", cutoffTime: "", fulfillmentModes: [], notes: "",
} };
beforeEach(() => { api.mockReset(); vi.stubEnv("API_BASE_URL", "http://api.test"); });
afterEach(() => vi.unstubAllEnvs());

it("preserves factory directory and history authority and binds the requested factory", async () => {
  api.mockResolvedValue(Response.json({ ...envelope, products: [], templates: [] }));
  expect(await loadFactoryDirectory(id)).toEqual({ data: { ...envelope, products: [], templates: [] } });
  api.mockResolvedValue(Response.json({ ...envelope, factoryId: id }));
  expect(await loadFactoryHistory(id)).toEqual({ data: { ...envelope, factoryId: id } });
  api.mockResolvedValue(Response.json({ ...envelope, factoryId: other }));
  expect(await loadFactoryHistory(id)).toMatchObject({ data: null, statusCode: 502 });
});

it.each([401, 403, 404])("keeps known factory read denial %i explicit", async status => {
  api.mockResolvedValue(Response.json({}, { status }));
  expect(await loadFactoryDirectory(id)).toMatchObject({ data: null, statusCode: status });
  expect(await loadFactoryHistory(id)).toMatchObject({ data: null, statusCode: status });
});

it.each([401, 403, 404])("clears factory form state only on known access or record loss %i", async status => {
  api.mockResolvedValue(Response.json({}, { status }));
  expect(await saveOperation("factory.create", input)).toMatchObject({ ok: false, denied: true });
});

it("preserves retryable original input on conflicts, server failures and unknown transport outcomes", async () => {
  for (const status of [409, 422, 500]) {
    api.mockResolvedValue(Response.json({}, { status }));
    expect(await saveOperation("factory.create", input)).not.toHaveProperty("denied");
    expect(JSON.parse(api.mock.calls.at(-1)![1].body).idempotencyKey).toBe(input.idempotencyKey);
  }
  api.mockRejectedValue(new Error("Synthetic connection loss"));
  expect(await saveOperation("factory.create", input)).not.toHaveProperty("denied");
  expect(await loadFactoryHistory(id)).not.toHaveProperty("statusCode");
});

it("rejects an unstamped response rather than filling private history", async () => {
  api.mockResolvedValue(Response.json({ factoryId: id, factories: [], capabilities: [] }));
  expect(await loadFactoryHistory(id)).toMatchObject({ data: null, error: expect.any(String) });
  api.mockResolvedValue(Response.json({ factories: [], capabilities: [], products: [], templates: [] }));
  expect(await loadFactoryDirectory()).toMatchObject({ data: null, error: expect.any(String) });
});

it("distinguishes the explicit authority change returned after I/O from an ordinary conflict", async () => {
  api.mockImplementation(async () => Response.json({ code: "authority_changed" }, { status: 409 }));
  expect(await loadFactoryDirectory(id)).toMatchObject({ data: null, statusCode: 409, denied: true });
  expect(await loadFactoryHistory(id)).toMatchObject({ data: null, statusCode: 409, denied: true });
  expect(await saveOperation("factory.create", input)).toMatchObject({ ok: false, denied: true });
  api.mockImplementation(async () => Response.json({ code: "version_conflict" }, { status: 409 }));
  expect(await loadFactoryHistory(id)).toMatchObject({ data: null, statusCode: 409, denied: false });
  expect(await saveOperation("factory.create", input)).not.toHaveProperty("denied");
});

it.each(["factory.create", "factory.revise", "factoryCapability.create", "factoryCapability.revise"] as const)("binds %s success to the original object, profile and immutable revision", async operation => {
  const capability = FactoryCapabilityProfileSchema.parse({ name: "Synthetic capability", productType: "other", productPlanId: null, skuId: null, fulfillmentScope: "process_only", processCodes: [], materials: [], specifications: "", minimumLongestMm: null, maximumLongestMm: null, sideModes: [], factoryStandardId: "", acceptedTemplateVersionIds: [], status: "draft", verificationStatus: "pending", verificationReference: "", sampleStatus: "untested", unitCostMinor: null, currency: "USD", minimumOrderQuantity: null, leadTimeDays: null, dailyCapacity: null, validFrom: "2026-10-21T00:00:00Z", validUntil: null, afterSalesTerms: "", evidenceReferences: [], notes: "" });
  const isCapability = operation.startsWith("factoryCapability"), revise = operation.endsWith("revise");
  const profile = isCapability ? capability : input.profile;
  const body = operation === "factory.create" ? input : { profile, idempotencyKey: input.idempotencyKey, ...(revise ? { expectedVersion: 1 } : {}) };
  const saved = { id, versionId: other, versionNumber: revise ? 2 : 1, updatedAt: "2026-10-21T00:00:00Z", profile, ...(isCapability ? { factoryId: id } : { supplierId: id, supplierName: "Synthetic supplier", supplierStatus: "active", supplierBlockers: [], code: input.code }) };
  api.mockResolvedValue(Response.json(saved)); expect(await saveOperation(operation, body, id)).toMatchObject({ ok: true });
  for (const changed of [{ ...saved, versionNumber: 7 }, { ...saved, profile: { ...profile, name: "Different saved input" } }, { ...saved, ...(operation === "factory.create" ? { supplierId: other } : operation === "factoryCapability.create" ? { factoryId: other } : { id: other }) }]) {
    api.mockResolvedValue(Response.json(changed));
    const result = await saveOperation(operation, body, id); expect(result.ok).toBe(false); expect(result).not.toHaveProperty("denied");
  }
});
