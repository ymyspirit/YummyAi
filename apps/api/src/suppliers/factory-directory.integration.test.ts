import { randomUUID } from "node:crypto";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { ForbiddenError, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { fulfillmentSuppliers, fulfillmentFactoryVersions, factoryCapabilityVersions, connectDatabase, withTenant } from "@yummyai/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditService } from "../audit/audit.service.js";
import { FactoryDirectoryService } from "./factory-directory.service.js";
import { createSyntheticFactory } from "./factory-directory.test-fixture.js";
import { syntheticFactoryProfile, syntheticFactoryCapability, syntheticSupplierProfile } from "../../../../tools/testing/factory-fixtures.js";

if (process.env.E2E_ISOLATED_DAILY !== "1" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname)) throw new Error("Use the disposable factory-directory-integration runner");
describe("tenant supplier has distinct factories and immutable manufacturing capabilities", () => {
  const database = connectDatabase(), tenantId = createEntityId(), foreignTenant = createEntityId(), userId = createEntityId(), supplierId = createEntityId(), ownedSupplierId = createEntityId(), unknownSupplierId = createEntityId();
  const context: TenantContext = { tenantId, userId, permissions: Object.values(Permission), dataScope: "tenant" }, other = { ...context, tenantId: foreignTenant };
  const service = new FactoryDirectoryService(database, new AuditService(database));
  beforeAll(async () => {
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic factories',$2),($3,'Synthetic other',$4)", [tenantId, `factories-${tenantId}`, foreignTenant, `factories-${foreignTenant}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic operator')", [userId, `factories-${userId}`, `${userId}@example.test`]);
    await withTenant(database.db, context, tx => tx.insert(fulfillmentSuppliers).values([
      { id: supplierId, tenantId, name: "Synthetic external supplier", kind: "manual", regionCode: "CN", settlementCurrency: "CNY", profile: syntheticSupplierProfile, createdBy: userId },
      { id: ownedSupplierId, tenantId, name: "Synthetic internal entity", kind: "manual", regionCode: "US", settlementCurrency: "USD", profile: { ...syntheticSupplierProfile, entityKind: "internal_entity" }, createdBy: userId },
      { id: unknownSupplierId, tenantId, name: "Legacy unknown supplier", kind: "manual", regionCode: "CN", settlementCurrency: "CNY", createdBy: userId },
    ]));
  });
  afterAll(async () => { await database.client.end(); }); // The isolated runner destroys all fixture resources, including on failure.
  it("stores two locations and different capabilities under one supplier with isolated histories", async () => {
    const a = await createSyntheticFactory(service, context, supplierId, "shaped_pillow", "Synthetic north site");
    const b = await createSyntheticFactory(service, context, supplierId, "engraving", "Synthetic south site");
    const revised = await service.revise(context, b.factory.id, { expectedVersion: 1, profile: { ...b.factory.profile, productionAddress: { ...b.factory.profile.productionAddress!, street: "Synthetic engraving address" } }, idempotencyKey: randomUUID() });
    const directory = await service.directory(context, { supplier: supplierId });
    expect(directory.factories.map(factory => factory.id)).toEqual(expect.arrayContaining([a.factory.id, b.factory.id]));
    expect(directory.capabilities.find(cap => cap.factoryId === a.factory.id)!.profile.productType).toBe("shaped_pillow");
    expect(directory.capabilities.find(cap => cap.factoryId === b.factory.id)!.profile.productType).toBe("engraving");
    expect(revised.profile.productionAddress!.street).not.toBe(a.factory.profile.productionAddress!.street);
    expect((await service.history(context, b.factory.id)).factories.map(version => version.profile.productionAddress!.street)).toEqual([b.factory.profile.productionAddress!.street, "Synthetic engraving address"]);
  });
  it("replays the original saved version, rejects changed retries and conflicts on stale edits", async () => {
    const input = { supplierId, code: `TEST-${randomUUID()}`, profile: syntheticFactoryProfile(), idempotencyKey: randomUUID() };
    const [a, b] = await Promise.all([service.create(context, input), service.create(context, input)]);
    expect(a.versionId).toBe(b.versionId);
    const revised = await service.revise(context, a.id, { expectedVersion: 1, profile: { ...a.profile, name: "Synthetic renamed site" }, idempotencyKey: randomUUID() });
    expect(revised.versionNumber).toBe(2);
    expect((await service.create(context, input)).profile.name).toBe(input.profile.name);
    await expect(service.create(context, { ...input, profile: { ...input.profile, name: "Changed retry" } })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.revise(context, a.id, { expectedVersion: 1, profile: a.profile, idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ConflictException);
    const capabilityInput = { profile: syntheticFactoryCapability(), idempotencyKey: randomUUID() }, capability = await service.createCapability(context, a.id, capabilityInput);
    await service.reviseCapability(context, capability.id, { expectedVersion: 1, profile: { ...capability.profile, unitCostMinor: 1250 }, idempotencyKey: randomUUID() });
    expect((await service.createCapability(context, a.id, capabilityInput)).profile.unitCostMinor).toBeNull();
    await expect(service.createCapability(context, a.id, { ...capabilityInput, profile: { ...capabilityInput.profile, unitCostMinor: 100 } })).rejects.toBeInstanceOf(ConflictException);
  });
  it("distinguishes owned sites from external suppliers and keeps unknown legacy data in draft", async () => {
    const input = { code: `TEST-${randomUUID()}`, profile: syntheticFactoryProfile(), idempotencyKey: randomUUID() };
    await expect(service.create(context, { ...input, supplierId: ownedSupplierId })).rejects.toBeInstanceOf(ConflictException);
    expect((await service.create(context, { ...input, supplierId: ownedSupplierId, profile: { ...input.profile, ownership: "owned" } })).profile.ownership).toBe("owned");
    await expect(service.create(context, { ...input, code: `TEST-${randomUUID()}`, idempotencyKey: randomUUID(), supplierId: unknownSupplierId })).rejects.toBeInstanceOf(ConflictException);
    expect((await service.create(context, { ...input, supplierId: unknownSupplierId, code: `TEST-${randomUUID()}`, idempotencyKey: randomUUID(), profile: { ...input.profile, status: "draft", productionAddress: null, contacts: [] } })).profile.status).toBe("draft");
  });
  it("enforces RLS, membership scope, parent ownership and immutable database versions", async () => {
    const f = await createSyntheticFactory(service, context, supplierId);
    expect((await service.directory(other)).factories).toEqual([]);
    expect(await withTenant(database.db, other, tx => tx.select().from(fulfillmentFactoryVersions).where(eq(fulfillmentFactoryVersions.id, f.factory.versionId)))).toEqual([]);
    await expect(service.history(other, f.factory.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.createCapability(other, f.factory.id, { profile: syntheticFactoryCapability(), idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.directory({ ...context, dataScope: "self" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.create({ ...context, permissions: [Permission.OrderRead] }, { supplierId, code: "DENIED", profile: f.factory.profile, idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(withTenant(database.db, context, tx => tx.update(fulfillmentFactoryVersions).set({ profile: { ...f.factory.profile, name: "Cannot overwrite" } }).where(eq(fulfillmentFactoryVersions.id, f.factory.versionId)))).rejects.toThrow();
    await expect(withTenant(database.db, context, tx => tx.delete(factoryCapabilityVersions).where(eq(factoryCapabilityVersions.id, f.capability.versionId)))).rejects.toThrow();
    await expect(service.createCapability(context, f.factory.id, { profile: { ...syntheticFactoryCapability(), productPlanId: createEntityId() }, idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.directory(context, { tenantId: foreignTenant })).rejects.toThrow();
  });
  it("persists partial factory and capability drafts but rejects activation and production release", async () => {
    const draft = await service.create(context, { supplierId: unknownSupplierId, code: "PARTIAL-DRAFT", idempotencyKey: randomUUID(), profile: { ...syntheticFactoryProfile(), status: "draft", timeZone: null, productionAddress: { province: "Synthetic province" }, contacts: [{ role: "production", name: "Synthetic partial contact" }] } });
    await expect(service.revise(context, draft.id, { expectedVersion: 1, idempotencyKey: randomUUID(), profile: { ...draft.profile, status: "active" } })).rejects.toThrow(/启用工厂/);
    const capability = await service.createCapability(context, draft.id, { idempotencyKey: randomUUID(), profile: { ...syntheticFactoryCapability(), status: "draft", minimumOrderQuantity: null, processCodes: [], verificationStatus: "pending", verificationReference: "" } });
    await expect(service.reviseCapability(context, capability.id, { expectedVersion: 1, idempotencyKey: randomUUID(), profile: { ...capability.profile, status: "active" } })).rejects.toThrow(/启用能力/);
    const directory = await service.directory(context, { supplier: unknownSupplierId });
    expect(directory.factories.find(factory => factory.id === draft.id)!.profile).toMatchObject({ status: "draft", timeZone: null, productionAddress: { province: "Synthetic province", city: "", street: "", countryCode: "" }, contacts: [{ name: "Synthetic partial contact", phone: "" }] });
    expect(directory.capabilities.find(item => item.id === capability.id)!.profile).toMatchObject({ status: "draft", minimumOrderQuantity: null, processCodes: [] });
    expect((await service.history(context, draft.id)).factories).toHaveLength(1);
    await expect(withTenant(database.db, context, tx => service.pinForRelease(tx, draft.id, draft.versionId, capability.versionId, unknownSupplierId, { productType: "shaped_pillow", productPlanId: null, skuId: null, quantity: 1 }))).rejects.toBeInstanceOf(ConflictException);
  });
  it("pins exact versions, rejects foreign and stale pins, and blocks paused factories or changed parent roles", async () => {
    const f = await createSyntheticFactory(service, context, supplierId, "shaped_pillow"), requirement = { productType: "shaped_pillow", productPlanId: null, skuId: null, quantity: 1, longestMm: 254, sideMode: "single" as const, factoryStandardId: f.capability.profile.factoryStandardId };
    const pin = await withTenant(database.db, context, tx => service.pinForRelease(tx, f.pins.factoryId, f.pins.factoryVersionId, f.pins.capabilityVersionId, supplierId, requirement));
    await expect(withTenant(database.db, other, tx => service.pinForRelease(tx, f.pins.factoryId, f.pins.factoryVersionId, f.pins.capabilityVersionId, supplierId, requirement))).rejects.toBeInstanceOf(ConflictException);
    const suspended = await service.revise(context, f.factory.id, { expectedVersion: 1, profile: { ...f.factory.profile, status: "suspended" }, idempotencyKey: randomUUID() });
    expect(await withTenant(database.db, context, tx => service.availability(tx, pin))).toContain("生产工厂已停用或未启用");
    await expect(withTenant(database.db, context, tx => service.pinForRelease(tx, f.pins.factoryId, f.pins.factoryVersionId, f.pins.capabilityVersionId, supplierId, requirement))).rejects.toBeInstanceOf(ConflictException);
    await service.revise(context, f.factory.id, { expectedVersion: suspended.versionNumber, profile: f.factory.profile, idempotencyKey: randomUUID() });
    await withTenant(database.db, context, tx => tx.update(fulfillmentSuppliers).set({ profile: { ...syntheticSupplierProfile, roles: [] } }).where(eq(fulfillmentSuppliers.id, supplierId)));
    try {
      expect((await service.choices(context, requirement)).find(choice => choice.pin.factoryId === f.factory.id)!.blockers).toContain("请先启用所属主体并确认其生产加工角色");
      expect(await withTenant(database.db, context, tx => service.availability(tx, pin))).toContain("请先启用所属主体并确认其生产加工角色");
    } finally { await withTenant(database.db, context, tx => tx.update(fulfillmentSuppliers).set({ profile: syntheticSupplierProfile }).where(eq(fulfillmentSuppliers.id, supplierId))); }
  });
  it("checks product, SKU, print sides, size, MOQ, template and quote validity against the chosen capability", async () => {
    const f = await createSyntheticFactory(service, context, supplierId, "shaped_pillow"), requirement = { productType: "shaped_pillow", productPlanId: null, skuId: null, quantity: 1, longestMm: 254 };
    const pin = await withTenant(database.db, context, tx => service.pinned(tx, f.pins.factoryId, f.pins.factoryVersionId, f.pins.capabilityVersionId));
    expect(service.requirementBlockers(pin!, "active", requirement, new Date())).toEqual([]);
    for (const patch of [{ productPlanId: createEntityId() }, { skuId: createEntityId(), productPlanId: createEntityId() }, { fulfillmentScope: "process_only" as const }, { minimumOrderQuantity: 2 }, { maximumLongestMm: 200 }, { sideModes: ["double"] as const }, { factoryStandardId: "other-standard" }, { acceptedTemplateVersionIds: [createEntityId()] }, { validUntil: "2021-01-01T00:00:00.000Z" }]) {
      const profile = { ...pin!.capabilityProfile, ...patch, sideModes: [...(patch.sideModes ?? pin!.capabilityProfile.sideModes)] };
      expect(service.requirementBlockers({ ...pin!, capabilityProfile: profile }, "active", { ...requirement, longestMm: 254, sideMode: "single", factoryStandardId: f.capability.profile.factoryStandardId }, new Date())).not.toEqual([]);
    }
  });
  it("blocks unknown size bounds in choices and release, then preserves the old capability after a confirmed revision", async () => {
    const f = await createSyntheticFactory(service, context, supplierId, "shaped_pillow");
    const input = { expectedVersion: 1, profile: { ...f.capability.profile, minimumLongestMm: null, maximumLongestMm: null }, idempotencyKey: randomUUID() };
    const unknown = await service.reviseCapability(context, f.capability.id, input);
    const requirement = { productType: "shaped_pillow", productPlanId: null, skuId: null, quantity: 1, longestMm: 254 };
    const legacyPin = await withTenant(database.db, context, tx => service.pinned(tx, f.factory.id, f.factory.versionId, unknown.versionId));
    for (const bounds of [{ minimumLongestMm: null, maximumLongestMm: 500 }, { minimumLongestMm: 100, maximumLongestMm: null }]) {
      expect(service.requirementBlockers({ ...legacyPin!, capabilityProfile: { ...unknown.profile, ...bounds } }, "active", requirement, new Date())).toContain("工厂可承接尺寸上下限尚未确认");
    }
    for (const longestMm of [null, 0, -1, NaN, Infinity]) expect(service.requirementBlockers(legacyPin!, "active", { ...requirement, longestMm }, new Date())).toContain("本单缺少有效的已确认尺寸");
    expect((await service.choices(context, requirement)).find(choice => choice.pin.capabilityId === unknown.id)!.blockers).toContain("工厂可承接尺寸上下限尚未确认");
    await expect(withTenant(database.db, context, tx => service.pinForRelease(tx, f.factory.id, f.factory.versionId, unknown.versionId, supplierId, requirement))).rejects.toThrow(/尺寸上下限尚未确认/);
    const confirmed = await service.reviseCapability(context, unknown.id, { expectedVersion: 2, profile: { ...unknown.profile, minimumLongestMm: 254, maximumLongestMm: 254 }, idempotencyKey: randomUUID() });
    expect((await service.choices(context, requirement)).find(choice => choice.pin.capabilityId === confirmed.id)!.blockers).toEqual([]);
    const pin = await withTenant(database.db, context, tx => service.pinForRelease(tx, f.factory.id, f.factory.versionId, confirmed.versionId, supplierId, requirement));
    expect(pin.capabilityVersionId).toBe(confirmed.versionId);
    for (const longestMm of [253.9, 254.1]) expect((await service.choices(context, { ...requirement, longestMm })).find(choice => choice.pin.capabilityId === confirmed.id)!.blockers).toContain("本单尺寸超出工厂可承接范围");
    expect((await service.reviseCapability(context, unknown.id, input)).versionId).toBe(unknown.versionId);
    expect((await service.history(context, f.factory.id)).capabilities.find(version => version.versionId === unknown.versionId)!.profile).toMatchObject({ minimumLongestMm: null, maximumLongestMm: null });
    expect(await withTenant(database.db, context, tx => service.availability(tx, { ...pin, capabilityVersionId: unknown.versionId, capabilityVersionNumber: unknown.versionNumber, capabilityProfile: unknown.profile }))).toEqual([]);
    await expect(withTenant(database.db, context, tx => service.pinForRelease(tx, f.factory.id, f.factory.versionId, unknown.versionId, supplierId, requirement))).rejects.toThrow(/已更新/);
  });
  it("uses database time for choice and release even when the application clock is wrong", async () => {
    const f = await createSyntheticFactory(service, context, supplierId, "shaped_pillow");
    const [{ now }] = await database.client.unsafe("select transaction_timestamp() as now");
    const at = new Date(now).getTime(), profile = { ...f.capability.profile, validFrom: new Date(at - 3600000).toISOString(), validUntil: new Date(at + 3600000).toISOString() };
    const capability = await service.reviseCapability(context, f.capability.id, { expectedVersion: 1, profile, idempotencyKey: randomUUID() });
    const requirement = { productType: "shaped_pillow", productPlanId: null, skuId: null, quantity: 1, longestMm: 254 };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (const clock of [at - 86400000, at + 86400000]) {
        vi.setSystemTime(clock);
        expect((await service.choices(context, requirement)).find(choice => choice.pin.capabilityId === capability.id)!.blockers).toEqual([]);
        expect((await withTenant(database.db, context, tx => service.pinForRelease(tx, f.factory.id, f.factory.versionId, capability.versionId, supplierId, requirement))).capabilityVersionId).toBe(capability.versionId);
      }
    } finally { vi.useRealTimers(); }
  });
});
