import { Permission, erpPermissionContext, permissionScope } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { OriginalOwnerError } from "@yummyai/contracts/common/original-owner-error";
import { productionOrders, productionOrderVersions, productionMilestoneEvents, qualityInspections, qualityDefects, qualityGroupDefects, productionDeliveryItems, productionDeliveryFeedback, type DatabaseConnection } from "@yummyai/database";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { currentOrderAuthority, withOrderAuthority, hasTenantOrderPermissions } from "./order-authority.js";
import { qualityInspectionOrder } from "./quality-quantity.js";
import { readProductionManufacturingPins } from "./production-manufacturing-read.js";
import { qualityGroupWorkspace } from "./quality-group-read.js";
import { factoryErpProgress } from "./factory-erp-projection.js";
import type { FactoryDirectoryReadPort } from "./factory-directory-read.js";
import type { OrderReadVault } from "./order-private-payload.js";
export class ProductionReadOwner {
constructor(private readonly database:DatabaseConnection,private readonly vault:OrderReadVault,private readonly factories?:FactoryDirectoryReadPort){}
async get(context: TenantContext, productionOrderId: string) {
    return withOrderAuthority(this.database.db, context, [Permission.OrderRead], async (tx) => {
      const [productionOrder] = await tx.select().from(productionOrders).where(eq(productionOrders.id, productionOrderId)).limit(1);
      if (!productionOrder) throw new OriginalOwnerError(404, "Production order not found");
      const versions = await tx.select({
        id: productionOrderVersions.id, versionNumber: productionOrderVersions.versionNumber,
        quantity: productionOrderVersions.quantity, designVersionId: productionOrderVersions.designVersionId,
        productionAssetIds: productionOrderVersions.productionAssetIds, instructionsChecksum: productionOrderVersions.instructionsChecksum,
        sourceWorkRevisionId: productionOrderVersions.sourceWorkRevisionId, sourceEditorProjectId: productionOrderVersions.sourceEditorProjectId,
        sourceEditorVersionId: productionOrderVersions.sourceEditorVersionId, sourceRenderId: productionOrderVersions.sourceRenderId,
        factoryId: productionOrderVersions.factoryId, factoryVersionId: productionOrderVersions.factoryVersionId, capabilityVersionId: productionOrderVersions.capabilityVersionId,
        expectedCompletionAt: productionOrderVersions.expectedCompletionAt, createdAt: productionOrderVersions.createdAt,
      }).from(productionOrderVersions).where(eq(productionOrderVersions.productionOrderId, productionOrderId)).orderBy(asc(productionOrderVersions.versionNumber));
      const milestones = await tx.select({
        id: productionMilestoneEvents.id, sequence: productionMilestoneEvents.sequence, type: productionMilestoneEvents.type,
        externalEventId: productionMilestoneEvents.externalEventId, evidenceCode: productionMilestoneEvents.evidenceCode,
        evidenceAssetIds: productionMilestoneEvents.evidenceAssetIds, actorUserId: productionMilestoneEvents.actorUserId,
        occurredAt: productionMilestoneEvents.occurredAt,
      }).from(productionMilestoneEvents).where(eq(productionMilestoneEvents.productionOrderId, productionOrderId)).orderBy(asc(productionMilestoneEvents.sequence));
      const inspections = await tx.select().from(qualityInspections).where(eq(qualityInspections.productionOrderId, productionOrderId)).orderBy(qualityInspectionOrder(sql`${qualityInspections}`));
      const defects = await tx.select({
        id: qualityDefects.id, inspectionId: qualityDefects.inspectionId, code: qualityDefects.code,
        severity: qualityDefects.severity, responsibility: qualityDefects.responsibility,
        disposition: qualityDefects.disposition, detailChecksum: qualityDefects.detailChecksum,
        evidenceAssetIds: qualityDefects.evidenceAssetIds, createdAt: qualityDefects.createdAt,
        qualityGroupId: qualityGroupDefects.qualityGroupId, affectedQuantity: qualityGroupDefects.affectedQuantity,
      }).from(qualityDefects).leftJoin(qualityGroupDefects, and(eq(qualityGroupDefects.defectId, qualityDefects.id), eq(qualityGroupDefects.tenantId, qualityDefects.tenantId)))
        .where(eq(qualityDefects.productionOrderId, productionOrderId));
      const currentVersion = versions.find(version => version.versionNumber === productionOrder.currentVersionNumber);
      const [delivery] = await tx.select({ packageId: productionDeliveryItems.packageId, itemId: productionDeliveryItems.id }).from(productionDeliveryItems)
        .where(and(eq(productionDeliveryItems.productionOrderId, productionOrderId), currentVersion ? eq(productionDeliveryItems.productionVersionId, currentVersion.id) : sql`false`)).orderBy(desc(productionDeliveryItems.id)).limit(1);
      const [receipt] = delivery ? await tx.select({ kind: productionDeliveryFeedback.kind }).from(productionDeliveryFeedback)
        .where(and(eq(productionDeliveryFeedback.itemId, delivery.itemId), sql`${productionDeliveryFeedback.kind} <> 'rework'`)).orderBy(desc(productionDeliveryFeedback.sequence)).limit(1) : [];
      const manufacturingPins = await readProductionManufacturingPins(tx, versions.map(version => version.id));
      const factoryPin = this.factories && productionOrder.factoryId && currentVersion?.factoryVersionId && currentVersion.capabilityVersionId ? await this.factories.pinned(tx, productionOrder.factoryId, currentVersion.factoryVersionId, currentVersion.capabilityVersionId) : null;
      const currentAuthority = await currentOrderAuthority(tx, context, [Permission.OrderRead]);
      const factoryPermissions = [Permission.OrderRead, Permission.OrderPiiRead, Permission.DesignRead, Permission.AssetRead];
      const factoryErp = delivery && context.permissionScopes !== undefined && hasTenantOrderPermissions(currentAuthority, factoryPermissions) && factoryPermissions.every(permission => permissionScope(currentAuthority, permission) === "tenant")
        ? await factoryErpProgress(tx, this.vault, delivery.itemId) : null;
      return { productionOrder, versions: versions.map(version => ({ ...version, manufacturing: manufacturingPins.get(version.id) ?? null })), factoryPin, milestones, inspections, defects, deliveryReceipt: delivery ? { ...delivery, status: receipt?.kind ?? "pending", factoryErp } : null };
    });
  }
evidenceIndex(context: TenantContext, orderId: string) {
    return withOrderAuthority(this.database.db, context, [Permission.OrderRead], async tx => {
      const rows = await tx.select({ id: productionOrders.id, orderId: productionOrders.orderId,
        projectionVersion: productionOrders.projectionVersion, currentVersionNumber: productionOrders.currentVersionNumber,
        updatedAt: sql<string>`${productionOrders.updatedAt}::text` }).from(productionOrders)
        .where(eq(productionOrders.orderId, orderId)).orderBy(asc(productionOrders.id)).limit(10_001);
      if (rows.length > 10_000) throw new OriginalOwnerError(409, { code: "production_read_index_limit", message: "本单生产记录超过读取上限 请缩小范围" });
      return rows;
    });
  }
async qualityGroups(context: TenantContext, productionOrderId: string) {
    return withOrderAuthority(this.database.db, context, [Permission.OrderRead], async tx => {
      const current = await currentOrderAuthority(tx, context, [Permission.OrderRead]);
      return { ...await qualityGroupWorkspace(tx, productionOrderId, this.vault),
        contextAuthority: erpSessionAuthority(erpPermissionContext(current)),
        access: { canRead: true as const, canWrite: hasTenantOrderPermissions(current, [Permission.OrderWrite]) } };
    });
  }
}
