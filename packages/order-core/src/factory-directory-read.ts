import { FactoryProductionPinSchema, type FactoryProductionPin, type FactoryProfile } from "@yummyai/contracts/suppliers/factory-directory";
import { SupplierProfileSchema } from "@yummyai/contracts/suppliers/supplier-profile";
import { fulfillmentFactories as factories, fulfillmentFactoryVersions as versions, factoryCapabilityVersions as capabilityVersions, factoryCapabilities as capabilities, fulfillmentSuppliers, type TenantTransaction } from "@yummyai/database";
import { and, eq } from "drizzle-orm";
export type FactoryDirectoryReadPort = Pick<FactoryDirectoryReadOwner,"pinned"|"availability">;
export class FactoryDirectoryReadOwner {
async pinned(tx: TenantTransaction, factoryId: string, factoryVersionId: string, capabilityVersionId: string): Promise<FactoryProductionPin | null> {
    const [row] = await tx.select({ factory: factories, version: versions, capability: capabilityVersions, supplier: fulfillmentSuppliers }).from(factories)
      .innerJoin(versions, and(eq(versions.factoryId, factories.id), eq(versions.id, factoryVersionId)))
      .innerJoin(capabilityVersions, and(eq(capabilityVersions.factoryId, factories.id), eq(capabilityVersions.id, capabilityVersionId)))
      .innerJoin(fulfillmentSuppliers, eq(fulfillmentSuppliers.id, factories.supplierId)).where(eq(factories.id, factoryId));
    return row ? FactoryProductionPinSchema.parse({ supplierId: row.supplier.id, supplierName: row.supplier.name, factoryId, factoryCode: row.factory.code, factoryVersionId, factoryVersionNumber: row.version.versionNumber, factoryProfile: row.version.profile, capabilityId: row.capability.capabilityId, capabilityVersionId, capabilityVersionNumber: row.capability.versionNumber, capabilityProfile: row.capability.profile }) : null;
  }
async availability(tx: TenantTransaction, pin: FactoryProductionPin | null) {
    if (!pin) return ["旧生产单未确认具体工厂，不能作为已绑定工厂的交付单"];
    const [factory] = await tx.select().from(factories).where(eq(factories.id, pin.factoryId));
    const [capability] = await tx.select().from(capabilities).where(eq(capabilities.id, pin.capabilityId));
    const [supplier] = await tx.select().from(fulfillmentSuppliers).where(eq(fulfillmentSuppliers.id, pin.supplierId));
    return [...(factory?.status === "active" ? [] : ["生产工厂已停用或未启用"]), ...(capability?.status === "active" ? [] : ["工厂能力已停用或未启用"]), ...this.parentBlockers(supplier, pin.factoryProfile)];
  }
parentBlockers(supplier: typeof fulfillmentSuppliers.$inferSelect | undefined, profile: FactoryProfile) {
    if (!supplier) return ["所属供应商不存在或无权访问"];
    const parent = SupplierProfileSchema.parse(supplier.profile), blockers: string[] = [];
    if (supplier.status !== "active" || !parent.roles.includes("manufacturing")) blockers.push("请先启用所属主体并确认其生产加工角色");
    if (profile.ownership === "owned" && parent.entityKind !== "internal_entity" || profile.ownership === "partner" && parent.entityKind !== "external_supplier") blockers.push("请核对工厂自有／外部合作性质与所属主体");
    return blockers;
  }
}
