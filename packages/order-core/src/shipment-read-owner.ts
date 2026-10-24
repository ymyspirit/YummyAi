import { Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { OriginalOwnerError } from "@yummyai/contracts/common/original-owner-error";
import { shipments, shipmentVersions, shipmentPackages, shipmentPackageLines, shipmentProductionAllocations, shipmentVersionReviews, shipmentTrackingEvents, shipmentWritebackRequests, shipmentManualConfirmations, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { and, asc, eq, sql } from "drizzle-orm";
import { withOrderAuthority } from "./order-authority.js";
import { physicalPackageEvidence } from "./work-query.js";
export class ShipmentReadOwner {constructor(private readonly database:DatabaseConnection){}
async get(context: TenantContext, shipmentId: string) {
    return withOrderAuthority(this.database.db, context, [Permission.OrderRead], async (tx) => {
      const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).limit(1);
      if (!shipment) throw new OriginalOwnerError(404, "Shipment not found");
      const versions = await tx.select().from(shipmentVersions).where(eq(shipmentVersions.shipmentId, shipmentId)).orderBy(asc(shipmentVersions.versionNumber));
      const packages = await tx.select().from(shipmentPackages).where(eq(shipmentPackages.shipmentId, shipmentId)).orderBy(asc(shipmentPackages.createdAt));
      const packageLines = await tx.select().from(shipmentPackageLines).where(eq(shipmentPackageLines.shipmentId, shipmentId)).orderBy(asc(shipmentPackageLines.createdAt));
      const productionAllocations = await tx.select().from(shipmentProductionAllocations).where(eq(shipmentProductionAllocations.shipmentId, shipmentId)).orderBy(asc(shipmentProductionAllocations.createdAt), asc(shipmentProductionAllocations.id));
      const reviews = await tx.select({
        id: shipmentVersionReviews.id, shipmentVersionId: shipmentVersionReviews.shipmentVersionId,
        decision: shipmentVersionReviews.decision, reasonCode: shipmentVersionReviews.reasonCode,
        reasonChecksum: shipmentVersionReviews.reasonChecksum, reviewedBy: shipmentVersionReviews.reviewedBy,
        reviewedAt: shipmentVersionReviews.reviewedAt,
      }).from(shipmentVersionReviews).where(eq(shipmentVersionReviews.shipmentId, shipmentId)).orderBy(asc(shipmentVersionReviews.reviewedAt));
      const tracking = await tx.select().from(shipmentTrackingEvents).where(eq(shipmentTrackingEvents.shipmentId, shipmentId)).orderBy(asc(shipmentTrackingEvents.occurredAt));
      const writebacks = await tx.select().from(shipmentWritebackRequests).where(eq(shipmentWritebackRequests.shipmentId, shipmentId)).orderBy(asc(shipmentWritebackRequests.createdAt));
      const manualConfirmations = await tx.select({ id: shipmentManualConfirmations.id, shipmentVersionId: shipmentManualConfirmations.shipmentVersionId,
        confirmedAt: shipmentManualConfirmations.confirmedAt, recordedAt: shipmentManualConfirmations.recordedAt })
        .from(shipmentManualConfirmations).where(eq(shipmentManualConfirmations.shipmentId, shipmentId)).orderBy(asc(shipmentManualConfirmations.recordedAt));
      return { shipment: { ...shipment, wholeOrder: shipment.idempotencyKey.startsWith("whole-order:") }, versions, packages, packageLines, productionAllocations, reviews, tracking, writebacks, manualConfirmations,
        physicalHandover: await readShipmentPhysicalHandover(tx, shipment) };
    });
  }
evidenceIndex(context: TenantContext, orderId: string) {
    return withOrderAuthority(this.database.db, context, [Permission.OrderRead], async tx => {
      const rows = await tx.select({ id: shipments.id, orderId: shipments.orderId,
        currentVersionNumber: shipments.currentVersionNumber, updatedAt: sql<string>`${shipments.updatedAt}::text` })
        .from(shipments).where(eq(shipments.orderId, orderId)).orderBy(asc(shipments.id)).limit(10_001);
      if (rows.length > 10_000) throw new OriginalOwnerError(409, { code: "shipment_read_index_limit", message: "本单发货记录超过读取上限 请缩小范围" });
      return rows;
    });
  }
}
export async function readShipmentPhysicalHandover(tx: TenantTransaction, shipment: typeof shipments.$inferSelect) {
  const [version] = shipment.approvedVersionNumber
    ? await tx.select({ id: shipmentVersions.id }).from(shipmentVersions).where(and(
      eq(shipmentVersions.shipmentId, shipment.id), eq(shipmentVersions.versionNumber, shipment.approvedVersionNumber),
    )) : [];
  if (!version) return { shipmentVersionId: null, packageCount: 0, dispatchedPackageCount: 0, allDispatched: false };
  const packages = await tx.select({ id: shipmentPackages.id, dispatched: physicalPackageEvidence(sql`${shipmentPackages.id}`) })
    .from(shipmentPackages).where(eq(shipmentPackages.shipmentVersionId, version.id));
  const dispatchedPackageCount = packages.filter((pkg) => pkg.dispatched === true).length;
  return { shipmentVersionId: version.id, packageCount: packages.length, dispatchedPackageCount,
    allDispatched: packages.length > 0 && dispatchedPackageCount === packages.length };
}
