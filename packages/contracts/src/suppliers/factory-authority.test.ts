import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { erpSessionAuthority, ErpContextAuthoritySchema } from "../auth/session.js";
import type { TenantContext } from "../tenant/tenant-context.js";
import { FactoryDirectorySchema, FactoryHistorySchema } from "./factory-directory.js";
import { syntheticFactoryCapability, syntheticFactoryProfile } from "../../../../tools/testing/factory-fixtures.js";

const tenantId = createEntityId(), userId = createEntityId(), supplierId = createEntityId(), factoryId = createEntityId();
const at = "2026-10-21T08:00:00.000Z";
function authority(read: "self" | "team" | "tenant" = "tenant", write: "self" | "team" | "tenant" = "tenant") {
  const value: TenantContext = { tenantId, userId, permissions: ["order:write", "order:read"], dataScope: "tenant",
    permissionScopes: { "order:read": read, "order:write": write }, teamIds: [] };
  return erpSessionAuthority(value);
}
function factory(versionNumber = 1) {
  return { id: factoryId, supplierId, supplierName: "Synthetic authority supplier", supplierStatus: "active", supplierBlockers: [],
    code: "SYNTHETIC-AUTHORITY", versionId: createEntityId(), versionNumber,
    profile: syntheticFactoryProfile(`Synthetic authority V${versionNumber}`), updatedAt: at };
}
function capability(id = createEntityId(), versionNumber = 1) {
  return { id, factoryId, versionId: createEntityId(), versionNumber, profile: syntheticFactoryCapability("other"), updatedAt: at };
}
function directory() {
  return { contextAuthority: authority(), access: { canRead: true, canWrite: true }, factories: [factory()], capabilities: [capability()], products: [], templates: [] };
}
function history() {
  return { contextAuthority: authority(), access: { canRead: true, canWrite: true }, factoryId, factories: [factory(1), factory(2)], capabilities: [capability()] };
}

describe("factory authority transport", () => {
  it("accepts a canonical ERP membership stamp rather than treating it as a credential or digest", () => {
    const stamp = authority();
    expect(ErpContextAuthoritySchema.parse(stamp)).toBe(stamp);
    expect(JSON.parse(stamp)).toMatchObject({ tenantId, userId, permissionScopes: { "order:read": "tenant", "order:write": "tenant" } });
    expect(FactoryDirectorySchema.parse(directory()).contextAuthority).toBe(stamp);
  });
  it.each(["", "a".repeat(64), "not-json", JSON.stringify({ tenantId, userId, permissions: [], dataScope: "tenant" }, null, 2)])(
    "rejects a missing, digest-only or noncanonical authority stamp (%s)", contextAuthority => {
      expect(FactoryDirectorySchema.safeParse({ ...directory(), contextAuthority }).success).toBe(false);
    });
  it("rejects stamp payloads with unknown credential-bearing fields", () => {
    const contextAuthority = JSON.stringify({ ...JSON.parse(authority()), token: "SYNTHETIC-NOT-A-CREDENTIAL" });
    expect(FactoryDirectorySchema.safeParse({ ...directory(), contextAuthority }).success).toBe(false);
  });
  it("preserves tenant Read plus self Write as a read-only directory and history", () => {
    const fields = { contextAuthority: authority("tenant", "self"), access: { canRead: true, canWrite: false } };
    expect(FactoryDirectorySchema.parse({ ...directory(), ...fields }).access).toEqual(fields.access);
    expect(FactoryHistorySchema.parse({ ...history(), ...fields }).access).toEqual(fields.access);
  });
  it("rejects inflated write access from a different tenant-scoped permission", () => {
    expect(FactoryDirectorySchema.safeParse({ ...directory(), contextAuthority: authority("tenant", "self") }).success).toBe(false);
    expect(FactoryHistorySchema.safeParse({ ...history(), contextAuthority: authority("tenant", "team") }).success).toBe(false);
  });
  it("does not expose private directory or history under self Read plus tenant Write", () => {
    const fields = { contextAuthority: authority("self", "tenant"), access: { canRead: false, canWrite: true } };
    expect(FactoryDirectorySchema.safeParse({ ...directory(), ...fields }).success).toBe(false);
    expect(FactoryHistorySchema.safeParse({ ...history(), ...fields }).success).toBe(false);
  });
  it("rejects a false read flag or a write flag that contradicts the canonical ceiling", () => {
    expect(FactoryDirectorySchema.safeParse({ ...directory(), access: { canRead: false, canWrite: true } }).success).toBe(false);
    expect(FactoryHistorySchema.safeParse({ ...history(), access: { canRead: true, canWrite: false } }).success).toBe(false);
  });
  it("requires both authority and access rather than defaulting a missing permission result", () => {
    const { contextAuthority: omittedStamp, ...withoutStamp } = directory();
    const { access: omittedAccess, ...withoutAccess } = history();
    expect(omittedStamp).toBeTruthy(); expect(omittedAccess.canRead).toBe(true);
    expect(FactoryDirectorySchema.safeParse(withoutStamp).success).toBe(false);
    expect(FactoryHistorySchema.safeParse(withoutAccess).success).toBe(false);
  });
  it("rejects unknown response fields and caller-injected tenant fields", () => {
    expect(FactoryDirectorySchema.safeParse({ ...directory(), tenantId }).success).toBe(false);
    expect(FactoryHistorySchema.safeParse({ ...history(), access: { canRead: true, canWrite: true, canApprove: true } }).success).toBe(false);
  });
  it("retains exact immutable factory and capability versions in a valid history", () => {
    const value = history(), parsed = FactoryHistorySchema.parse(value);
    expect(parsed).toEqual(value);
    expect(parsed.factories.map(row => row.versionNumber)).toEqual([1, 2]);
  });
  it("rejects factory history rows belonging to another requested factory", () => {
    const value = history(); value.factories[0]!.id = createEntityId();
    expect(FactoryHistorySchema.safeParse(value).success).toBe(false);
  });
  it("rejects capability history rows belonging to another requested factory", () => {
    const value = history(); value.capabilities[0]!.factoryId = createEntityId();
    expect(FactoryHistorySchema.safeParse(value).success).toBe(false);
  });
  it.each(["factories", "capabilities"] as const)("rejects repeated immutable %s version IDs", section => {
    const value = history(); value[section].push(structuredClone(value[section][0]!) as never);
    expect(FactoryHistorySchema.safeParse(value).success).toBe(false);
  });
  it("rejects two different immutable IDs claiming the same factory version number", () => {
    const value = history(); value.factories.push(factory(1));
    expect(FactoryHistorySchema.safeParse(value).success).toBe(false);
  });
  it("rejects two different immutable IDs claiming the same capability version number", () => {
    const value = history(); value.capabilities.push(capability(value.capabilities[0]!.id, 1));
    expect(FactoryHistorySchema.safeParse(value).success).toBe(false);
  });
  it("allows different capabilities to each retain their own version one", () => {
    const value = history(); value.capabilities.push(capability());
    expect(FactoryHistorySchema.parse(value).capabilities).toHaveLength(2);
  });
});
