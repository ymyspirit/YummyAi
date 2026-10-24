import { FactoryDirectoryReadOwner } from "@yummyai/order-core";
import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Permission, erpPermissionContext, requireTenantOrderPermissions } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";

import { CreateFactorySchema, ReviseFactorySchema, CreateFactoryCapabilitySchema, ReviseFactoryCapabilitySchema, FactoryDirectorySchema, FactoryHistorySchema, FactoryViewSchema, FactoryCapabilityViewSchema, FactoryProductionPinSchema, type FactoryProfile, type FactoryCapabilityProfile, type FactoryProductionPin, type ProductionFactoryChoice } from "@yummyai/contracts/suppliers/factory-directory";
import { fulfillmentSuppliers, fulfillmentFactories as factories, fulfillmentFactoryVersions as versions, factoryCapabilities as capabilities, factoryCapabilityVersions as capabilityVersions, productPlans, spus, skus, printProfiles, printProfileVersions, type DatabaseConnection, type TenantTransaction, withTenant } from "@yummyai/database";
import { currentOrderAuthority, hasTenantOrderPermissions } from "@yummyai/order-core";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

export interface FactoryRequirement {
  productType?: string; productPlanId: string | null; skuId: string | null; quantity: number;
  longestMm?: number | null; sideMode?: "single" | "double"; factoryStandardId?: string; templateVersionId?: string | null;
}
const Query = z.object({ supplier: z.uuidv7().optional() }).strict();
const checksum = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type FactoryVersion = typeof versions.$inferSelect;
type CapabilityVersion = typeof capabilityVersions.$inferSelect;

@Injectable()
export class FactoryDirectoryService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection, @Inject(AuditService) private readonly audit: AuditService) {}

  async directory(context: TenantContext, rawQuery: unknown = {}) {
    this.access(context); const query = Query.parse(rawQuery);
    return withTenant(this.database.db, context, async tx => {
      const current = await currentOrderAuthority(tx, context, [Permission.OrderRead]);
      return this.directoryInTransaction(tx, current, query);
    }, { isolationLevel: "repeatable read", accessMode: "read write" });
  }
  private async directoryInTransaction(tx: TenantTransaction, current: TenantContext, query: z.infer<typeof Query>) {
      const rows = await tx.select({ factory: factories, version: versions, supplier: fulfillmentSuppliers }).from(factories)
        .innerJoin(versions, and(eq(versions.factoryId, factories.id), eq(versions.versionNumber, factories.currentVersionNumber)))
        .innerJoin(fulfillmentSuppliers, eq(fulfillmentSuppliers.id, factories.supplierId)).where(query.supplier ? eq(factories.supplierId, query.supplier) : undefined)
        .orderBy(asc(factories.name), asc(factories.id)).limit(501);
      if (rows.length > 500) throw new ConflictException("工厂数量较多，请按供应商查看");
      const ids = rows.map(row => row.factory.id);
      const capRows = ids.length ? await tx.select({ capability: capabilities, version: capabilityVersions }).from(capabilities)
        .innerJoin(capabilityVersions, and(eq(capabilityVersions.capabilityId, capabilities.id), eq(capabilityVersions.versionNumber, capabilities.currentVersionNumber)))
        .where(inArray(capabilities.factoryId, ids)).orderBy(asc(capabilities.name), asc(capabilities.id)).limit(5001) : [];
      if (capRows.length > 5000) throw new ConflictException("工厂能力数量较多，请按供应商查看");
      const products = await tx.select({ id: productPlans.id, name: productPlans.name }).from(productPlans).where(sql`${productPlans.status}<>'archived'`).orderBy(asc(productPlans.name)).limit(500);
      const skuRows = products.length ? await tx.select({ id: skus.id, code: skus.code, plan: spus.productPlanId }).from(skus).innerJoin(spus, eq(spus.id, skus.spuId)).where(and(inArray(spus.productPlanId, products.map(product => product.id)), sql`${skus.status}<>'archived'`)) : [];
      const templates = await tx.select({ id: printProfileVersions.id, name: printProfileVersions.name, versionNumber: printProfileVersions.versionNumber }).from(printProfileVersions).innerJoin(printProfiles, eq(printProfiles.id, printProfileVersions.profileId)).where(sql`${printProfiles.archivedAt} is null`).orderBy(asc(printProfileVersions.name), asc(printProfileVersions.versionNumber)).limit(1000);
      return FactoryDirectorySchema.parse({
        ...this.viewAuthority(current),
        factories: rows.map(row => this.factoryView(row.factory, row.version, row.supplier)),
        capabilities: capRows.map(row => this.capabilityView(row.capability, row.version)),
        products: products.map(product => ({ ...product, skus: skuRows.filter(sku => sku.plan === product.id).map(({ id, code }) => ({ id, code })) })),
        templates,
      });
  }

  async create(context: TenantContext, raw: unknown) {
    this.access(context, true); const input = CreateFactorySchema.parse(raw), hash = checksum({ action: "factory.create", input });
    return withTenant(this.database.db, context, async tx => {
      const current = await currentOrderAuthority(tx, context, [Permission.OrderWrite]);
      await this.lock(tx, `factory-request:${input.idempotencyKey}`);
      const replay = await tx.select().from(versions).where(eq(versions.idempotencyKey, input.idempotencyKey));
      if (replay[0]) { this.sameRequest(replay[0].requestChecksum, hash); return this.versionView(tx, replay[0]); }
      const supplier = await this.parent(tx, input.supplierId, input.profile);
      if ((await tx.select({ id: factories.id }).from(factories).where(eq(factories.code, input.code))).length) throw new ConflictException("工厂编码已存在");
      const [factory] = await tx.insert(factories).values({ id: createEntityId(), tenantId: current.tenantId, supplierId: supplier.id, code: input.code, name: input.profile.name, status: input.profile.status, currentVersionNumber: 1, createdBy: current.userId }).returning();
      const [version] = await tx.insert(versions).values({ id: createEntityId(), tenantId: current.tenantId, factoryId: factory!.id, versionNumber: 1, profile: input.profile, idempotencyKey: input.idempotencyKey, requestChecksum: hash, createdBy: current.userId }).returning();
      await this.audit.recordInTransaction(tx, current, { action: "factory.create", resourceType: "fulfillment_factory", resourceId: factory!.id, result: "success" });
      return this.factoryView(factory!, version!, supplier);
    });
  }

  async revise(context: TenantContext, id: string, raw: unknown) {
    this.access(context, true); const input = ReviseFactorySchema.parse(raw), hash = checksum({ action: "factory.revise", id, input });
    return withTenant(this.database.db, context, async tx => {
      const authority = await currentOrderAuthority(tx, context, [Permission.OrderWrite]);
      await this.lock(tx, `factory-request:${input.idempotencyKey}`); await this.lock(tx, `factory:${id}`);
      const [replay] = await tx.select().from(versions).where(eq(versions.idempotencyKey, input.idempotencyKey));
      if (replay) { this.sameRequest(replay.requestChecksum, hash); return this.versionView(tx, replay); }
      const [factory] = await tx.select().from(factories).where(eq(factories.id, id));
      if (!factory) throw new NotFoundException("工厂不存在");
      if (factory.currentVersionNumber !== input.expectedVersion) throw new ConflictException("工厂资料已更新，请刷新后重试");
      const supplier = await this.parent(tx, factory.supplierId, input.profile);
      const [version] = await tx.insert(versions).values({ id: createEntityId(), tenantId: authority.tenantId, factoryId: id, versionNumber: input.expectedVersion + 1, profile: input.profile, idempotencyKey: input.idempotencyKey, requestChecksum: hash, createdBy: authority.userId }).returning();
      const [current] = await tx.update(factories).set({ name: input.profile.name, status: input.profile.status, currentVersionNumber: version!.versionNumber, updatedAt: new Date() }).where(eq(factories.id, id)).returning();
      await this.audit.recordInTransaction(tx, authority, { action: "factory.revise", resourceType: "fulfillment_factory", resourceId: id, result: "success" });
      return this.factoryView(current!, version!, supplier);
    });
  }

  async createCapability(context: TenantContext, factoryId: string, raw: unknown) {
    this.access(context, true); const input = CreateFactoryCapabilitySchema.parse(raw);
    return this.writeCapability(context, factoryId, null, input.profile, input.idempotencyKey, checksum({ action: "capability.create", factoryId, input }), null);
  }
  async reviseCapability(context: TenantContext, capabilityId: string, raw: unknown) {
    this.access(context, true); const input = ReviseFactoryCapabilitySchema.parse(raw);
    const [capability] = await withTenant(this.database.db, context, async tx => {
      await currentOrderAuthority(tx, context, [Permission.OrderWrite]);
      return tx.select().from(capabilities).where(eq(capabilities.id, capabilityId));
    });
    if (!capability) throw new NotFoundException("工厂能力不存在");
    return this.writeCapability(context, capability.factoryId, capabilityId, input.profile, input.idempotencyKey, checksum({ action: "capability.revise", capabilityId, input }), input.expectedVersion);
  }
  private async writeCapability(context: TenantContext, factoryId: string, capabilityId: string | null, profile: FactoryCapabilityProfile, key: string, hash: string, expected: number | null) {
    return withTenant(this.database.db, context, async tx => {
      const authority = await currentOrderAuthority(tx, context, [Permission.OrderWrite]);
      await this.lock(tx, `capability-request:${key}`); await this.lock(tx, `factory:${factoryId}`);
      if (capabilityId) await this.lock(tx, `capability:${capabilityId}`);
      const [replay] = await tx.select().from(capabilityVersions).where(eq(capabilityVersions.idempotencyKey, key));
      if (replay) { this.sameRequest(replay.requestChecksum, hash); const [current] = await tx.select().from(capabilities).where(eq(capabilities.id, replay.capabilityId)); return this.capabilityView(current!, replay); }
      const [factory] = await tx.select().from(factories).where(eq(factories.id, factoryId));
      if (!factory || factory.status === "archived") throw new ConflictException("工厂不存在或已归档");
      await this.validateCapability(tx, profile);
      let current = capabilityId ? (await tx.select().from(capabilities).where(eq(capabilities.id, capabilityId)))[0] : undefined;
      if (capabilityId && (!current || current.currentVersionNumber !== expected)) throw new ConflictException("工厂能力已更新，请刷新后重试");
      if (!current) [current] = await tx.insert(capabilities).values({ id: createEntityId(), tenantId: authority.tenantId, factoryId, name: profile.name, status: profile.status, currentVersionNumber: 1, createdBy: authority.userId }).returning();
      const [version] = await tx.insert(capabilityVersions).values({ id: createEntityId(), tenantId: authority.tenantId, factoryId, capabilityId: current!.id, versionNumber: (expected ?? 0) + 1, profile, idempotencyKey: key, requestChecksum: hash, createdBy: authority.userId }).returning();
      const [updated] = await tx.update(capabilities).set({ name: profile.name, status: profile.status, currentVersionNumber: version!.versionNumber, updatedAt: new Date() }).where(eq(capabilities.id, current!.id)).returning();
      await this.audit.recordInTransaction(tx, authority, { action: "factory_capability.save", resourceType: "factory_capability", resourceId: current!.id, result: "success" });
      return this.capabilityView(updated!, version!);
    });
  }

  async history(context: TenantContext, factoryId: string) {
    this.access(context);
    return withTenant(this.database.db, context, async tx => {
      const current = await currentOrderAuthority(tx, context, [Permission.OrderRead]);
      const [factory] = await tx.select().from(factories).where(eq(factories.id, factoryId)); if (!factory) throw new NotFoundException("工厂不存在");
      const [supplier] = await tx.select().from(fulfillmentSuppliers).where(eq(fulfillmentSuppliers.id, factory.supplierId));
      const rows = await tx.select().from(versions).where(eq(versions.factoryId, factoryId)).orderBy(asc(versions.versionNumber));
      const caps = await tx.select().from(capabilityVersions).where(eq(capabilityVersions.factoryId, factoryId)).orderBy(asc(capabilityVersions.createdAt));
      return FactoryHistorySchema.parse({ ...this.viewAuthority(current), factoryId: factory.id,
        factories: rows.map(version => this.factoryView(factory, version, supplier!)),
        capabilities: caps.map(version => ({ id: version.capabilityId, factoryId: version.factoryId, versionId: version.id, versionNumber: version.versionNumber, profile: version.profile, updatedAt: version.createdAt.toISOString() })) });
    }, { isolationLevel: "repeatable read", accessMode: "read write" });
  }

  async choices(context: TenantContext, requirement: FactoryRequirement): Promise<ProductionFactoryChoice[]> {
    this.access(context);
    return withTenant(this.database.db, context, async tx => {
      const current = await currentOrderAuthority(tx, context, [Permission.OrderRead]);
      const directory = await this.directoryInTransaction(tx, current, {}), now = await this.databaseTime(tx);
      return directory.capabilities.map(capability => {
        const factory = directory.factories.find(row => row.id === capability.factoryId)!;
        const pin = FactoryProductionPinSchema.parse({ supplierId: factory.supplierId, supplierName: factory.supplierName, factoryId: factory.id, factoryCode: factory.code, factoryVersionId: factory.versionId, factoryVersionNumber: factory.versionNumber, factoryProfile: factory.profile, capabilityId: capability.id, capabilityVersionId: capability.versionId, capabilityVersionNumber: capability.versionNumber, capabilityProfile: capability.profile });
        return { pin, blockers: [...factory.supplierBlockers, ...this.requirementBlockers(pin, factory.supplierStatus, requirement, now)] };
      }).filter(choice => !requirement.productType || choice.pin.capabilityProfile.productType === requirement.productType);
    }, { isolationLevel: "repeatable read", accessMode: "read write" });
  }
  async pinForRelease(tx: TenantTransaction, factoryId: string, factoryVersionId: string, capabilityVersionId: string, supplierId: string, requirement: FactoryRequirement) {
    await this.lock(tx, `factory:${factoryId}`);
    const pin = await this.pinned(tx, factoryId, factoryVersionId, capabilityVersionId);
    if (!pin || pin.supplierId !== supplierId) throw new ConflictException("工厂与供应商归属不匹配");
    await this.lock(tx, `capability:${pin.capabilityId}`);
    const [factory] = await tx.select().from(factories).where(eq(factories.id, factoryId));
    const [capability] = await tx.select().from(capabilities).where(eq(capabilities.id, pin.capabilityId));
    if (factory!.currentVersionNumber !== pin.factoryVersionNumber || capability!.currentVersionNumber !== pin.capabilityVersionNumber) throw new ConflictException("工厂资料或能力已更新，请重新选择");
    const [supplier] = await tx.select().from(fulfillmentSuppliers).where(eq(fulfillmentSuppliers.id, supplierId));
    await this.parent(tx, supplierId, pin.factoryProfile);
    const blockers = await this.requirementBlockersInTransaction(tx, pin, supplier!.status, requirement);
    if (blockers.length) throw new ConflictException(blockers.join("；")); return pin;
  }
  async pinned(tx: TenantTransaction, factoryId: string, factoryVersionId: string, capabilityVersionId: string): Promise<FactoryProductionPin | null> { return new FactoryDirectoryReadOwner().pinned(tx, factoryId, factoryVersionId, capabilityVersionId); }
  async availability(tx: TenantTransaction, pin: FactoryProductionPin | null) { return new FactoryDirectoryReadOwner().availability(tx, pin); }
  async lockPins(tx: TenantTransaction, pins: FactoryProductionPin[]) {
    for (const id of [...new Set(pins.map(pin => pin.factoryId))].sort()) await this.lock(tx, `factory:${id}`);
    for (const id of [...new Set(pins.map(pin => pin.capabilityId))].sort()) await this.lock(tx, `capability:${id}`);
    const ids = [...new Set(pins.map(pin => pin.supplierId))].sort();
    if (ids.length) await tx.select({ id: fulfillmentSuppliers.id }).from(fulfillmentSuppliers).where(inArray(fulfillmentSuppliers.id, ids)).orderBy(asc(fulfillmentSuppliers.id)).for("update");
  }
  requirementBlockers(pin: FactoryProductionPin, supplierStatus: string, requirement: FactoryRequirement, now: Date) {
    const factory = pin.factoryProfile, capability = pin.capabilityProfile, blockers: string[] = [];
    if (supplierStatus !== "active") blockers.push("供应商未启用"); if (factory.status !== "active") blockers.push("工厂未启用");
    if (capability.status !== "active" || capability.verificationStatus !== "confirmed" || capability.sampleStatus === "failed") blockers.push("工厂能力未核验启用");
    if (capability.fulfillmentScope !== "full_product") blockers.push("该能力仅承接部分工序，不能下达整件生产");
    if (requirement.productType && capability.productType !== requirement.productType) blockers.push("工厂不承接该产品类型");
    if (capability.productPlanId && capability.productPlanId !== requirement.productPlanId || capability.skuId && capability.skuId !== requirement.skuId) blockers.push("工厂能力不适用于本单产品或 SKU");
    if (factory.timeZone === null) blockers.push("工厂时区尚未确认");
    if (capability.minimumOrderQuantity === null) blockers.push("工厂最低接单量尚未确认");
    else if (requirement.quantity < capability.minimumOrderQuantity) blockers.push("数量未达到工厂最低接单量");
    if (requirement.longestMm != null) {
      if (!Number.isFinite(requirement.longestMm) || requirement.longestMm <= 0) blockers.push("本单缺少有效的已确认尺寸");
      else if (capability.minimumLongestMm === null || capability.maximumLongestMm === null) blockers.push("工厂可承接尺寸上下限尚未确认");
      else if (requirement.longestMm < capability.minimumLongestMm || requirement.longestMm > capability.maximumLongestMm) blockers.push("本单尺寸超出工厂可承接范围");
    } else if (requirement.productType) blockers.push("本单缺少有效的已确认尺寸");
    if (requirement.sideMode && !capability.sideModes.includes(requirement.sideMode)) blockers.push("工厂不承接本单印刷面数");
    if (requirement.factoryStandardId && capability.factoryStandardId !== requirement.factoryStandardId) blockers.push("工厂未确认本单工艺标准");
    if (capability.acceptedTemplateVersionIds.length && (!requirement.templateVersionId || !capability.acceptedTemplateVersionIds.includes(requirement.templateVersionId))) blockers.push("工厂未确认本单模板版本");
    if (new Date(capability.validFrom) > now || capability.validUntil && new Date(capability.validUntil) <= now) blockers.push("工厂能力或报价不在有效期");
    return blockers;
  }
  async requirementBlockersInTransaction(tx: TenantTransaction, pin: FactoryProductionPin, supplierStatus: string, requirement: FactoryRequirement) {
    return this.requirementBlockers(pin, supplierStatus, requirement, await this.databaseTime(tx));
  }
  private async databaseTime(tx: TenantTransaction) {
    const [row] = await tx.execute<{ now: string }>(sql`select transaction_timestamp()::text as now`);
    return new Date(row!.now);
  }
  private async validateCapability(tx: TenantTransaction, profile: FactoryCapabilityProfile) {
    if (profile.productPlanId && !(await tx.select({ id: productPlans.id }).from(productPlans).where(eq(productPlans.id, profile.productPlanId))).length) throw new ConflictException("产品不存在或无权访问");
    if (profile.skuId) {
      const [sku] = await tx.select({ plan: spus.productPlanId }).from(skus).innerJoin(spus, eq(spus.id, skus.spuId)).where(eq(skus.id, profile.skuId));
      if (!sku || sku.plan !== profile.productPlanId) throw new ConflictException("SKU 不属于指定产品");
    }
    if (profile.acceptedTemplateVersionIds.length) {
      const found = await tx.select({ id: printProfileVersions.id }).from(printProfileVersions).where(inArray(printProfileVersions.id, profile.acceptedTemplateVersionIds));
      if (new Set(found.map(row => row.id)).size !== new Set(profile.acceptedTemplateVersionIds).size) throw new ConflictException("工艺模板版本不存在或无权访问");
    }
  }
  private async parent(tx: TenantTransaction, id: string, profile: FactoryProfile) {
    const [supplier] = await tx.select().from(fulfillmentSuppliers).where(eq(fulfillmentSuppliers.id, id)).for("update"); if (!supplier) throw new NotFoundException("供应商不存在");
    const blockers = profile.status === "active" ? this.parentBlockers(supplier, profile) : [];
    if (blockers.length) throw new ConflictException(blockers.join("；"));
    return supplier;
  }
  private parentBlockers(supplier: typeof fulfillmentSuppliers.$inferSelect | undefined, profile: FactoryProfile) { return new FactoryDirectoryReadOwner().parentBlockers(supplier, profile); }
  private async versionView(tx: TenantTransaction, version: FactoryVersion) {
    const [factory] = await tx.select().from(factories).where(eq(factories.id, version.factoryId)); const [supplier] = await tx.select().from(fulfillmentSuppliers).where(eq(fulfillmentSuppliers.id, factory!.supplierId)); return this.factoryView(factory!, version, supplier!);
  }
  private factoryView(factory: typeof factories.$inferSelect, version: FactoryVersion, supplier: typeof fulfillmentSuppliers.$inferSelect) { return FactoryViewSchema.parse({ id: factory.id, supplierId: supplier.id, supplierName: supplier.name, supplierStatus: supplier.status, supplierBlockers: this.parentBlockers(supplier, version.profile), code: factory.code, versionId: version.id, versionNumber: version.versionNumber, profile: version.profile, updatedAt: version.createdAt.toISOString() }); }
  private capabilityView(capability: typeof capabilities.$inferSelect, version: CapabilityVersion) { return FactoryCapabilityViewSchema.parse({ id: capability.id, factoryId: capability.factoryId, versionId: version.id, versionNumber: version.versionNumber, profile: version.profile, updatedAt: version.createdAt.toISOString() }); }
  private sameRequest(saved: string, actual: string) { if (saved !== actual) throw new ConflictException("同一次保存的重试内容不能改变"); }
  private lock(tx: TenantTransaction, key: string) { return tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`); }
  private viewAuthority(current: TenantContext) {
    return { contextAuthority: erpSessionAuthority(erpPermissionContext(current)), access: {
      canRead: hasTenantOrderPermissions(current, [Permission.OrderRead]),
      canWrite: hasTenantOrderPermissions(current, [Permission.OrderWrite]),
    } };
  }
  private access(context: TenantContext, write = false) { requireTenantOrderPermissions(context, [write ? Permission.OrderWrite : Permission.OrderRead]); }
}
