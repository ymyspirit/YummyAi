import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { currentOrderAuthority } from "@yummyai/order-core";
import type { TenantContext } from "@yummyai/contracts";
import { FulfillmentCommandReceiptSchema, type FulfillmentCommandReceipt, type FulfillmentCommandSummary } from "@yummyai/contracts/order/fulfillment-command";
import { orderLines, orders, orderProtectedDetails, orderWorkItems, orderWorkEvents, productionEditorProjects, productionOrderVersions, productionOrders,
  productionDeliveryPackages, productionDeliveryItems, productionDeliveryFeedback, productionMilestoneEvents, qualityInspections, qualityInspectionGroups,
  productionRecoveryCases, shipments, shipmentVersions, shipmentPackageLines, shipmentVersionReviews, shipmentTrackingEvents, shipmentManualConfirmations,
  type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { and, asc, eq, inArray, like, sql } from "drizzle-orm";
import { DATABASE_CONNECTION, ORDER_PII_VAULT } from "../platform.tokens.js";
import { OrderProductionService, assertRecoveryReplay } from "./order-production.service.js";
import { OrderProductionDeliveryService } from "./order-production-delivery.service.js";
import { OrderShipmentService, assertShipmentVersionReplay } from "./order-shipment.service.js";
import { assertInspectionReplay } from "./quality-inspection-evidence.js";
import { groupInspectionChecksum } from "./quality-groups.js";
import { fulfillmentCommandPermissions, type FulfillmentOwnerCommand, type OrderFulfillmentCommandFence } from "./order-fulfillment-command-fence.js";

export type { FulfillmentOwnerCommand, OrderFulfillmentCommandFence } from "./order-fulfillment-command-fence.js";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const mismatch = () => new ConflictException("原履约回执的目标 正文 版本或操作员不匹配");
const labels: Record<FulfillmentOwnerCommand["kind"], string> = {
  delivery_create: "创建工厂交付包", delivery_feedback: "登记工厂文件回执", production_milestone: "登记生产进度",
  quality_inspection: "登记实物质检", quality_group_inspection: "登记实物分组质检", production_recovery: "登记生产后续处理",
  whole_production_milestone: "登记整单生产进度", whole_quality_inspection: "登记整单实物质检",
  shipment_create: "创建包裹", whole_shipment_create: "创建整单包裹", shipment_version: "修订包裹版本",
  shipment_review: "审核原包裹版本", shipment_dispatch: "登记实际交运", shipment_platform_confirmation: "登记平台人工核对",
};

/** Part of the order domain: the journal carries execution identity, while these
 * original immutable owner rows remain the only evidence of business success. */
@Injectable()
export class OrderFulfillmentCommandOwner {
  constructor(@Inject(DATABASE_CONNECTION) database: DatabaseConnection,
    @Inject(ORDER_PII_VAULT) vault: SecretVault,
    @Inject(OrderProductionService) private readonly production: OrderProductionService,
    @Inject(OrderProductionDeliveryService) private readonly delivery: OrderProductionDeliveryService,
    @Inject(OrderShipmentService) private readonly shipment: OrderShipmentService) {
    // Keep composition aligned with the original owners; this metadata reader
    // never opens their encrypted customer documents or duplicates their vaults.
    void database; void vault;
  }

  async describe(tx: TenantTransaction, context: TenantContext, command: FulfillmentOwnerCommand): Promise<{
    orderId: string; lineIds: string[]; summary: FulfillmentCommandSummary; deadline: number;
  }> {
    await currentOrderAuthority(tx, context, fulfillmentCommandPermissions(command, false), { requireMembership: true, lock: false });
    let orderId: string, lineIds: string[];
    const productionIds: string[] = [], productionVersionIds: string[] = [], projectIds: string[] = [];
    if (command.kind === "delivery_create") {
      const rows = await tx.select().from(productionOrders).where(inArray(productionOrders.id, command.input.items.map(item => item.productionOrderId)));
      if (rows.length !== command.input.items.length || rows.some(row => row.orderId !== command.targetId)) throw mismatch();
      orderId = command.targetId; lineIds = rows.map(row => row.orderLineId); productionVersionIds.push(...command.input.items.map(item => item.productionVersionId));
      const versions = await tx.select({ id: productionOrderVersions.id, productionId: productionOrderVersions.productionOrderId }).from(productionOrderVersions)
        .where(inArray(productionOrderVersions.id, productionVersionIds));
      if (versions.length !== command.input.items.length || versions.some(version => !command.input.items.some(item => item.productionVersionId === version.id && item.productionOrderId === version.productionId))) throw mismatch();
    } else if (command.kind === "delivery_feedback") {
      const [item] = await tx.select().from(productionDeliveryItems).where(and(eq(productionDeliveryItems.id, command.targetId), eq(productionDeliveryItems.packageId, command.packageId)));
      const [production] = item ? await tx.select().from(productionOrders).where(eq(productionOrders.id, item.productionOrderId)) : [];
      if (!item || !production) throw new NotFoundException("原交付文件不存在");
      orderId = production.orderId; lineIds = [production.orderLineId]; projectIds.push(item.editorProjectId);
    } else if (command.kind === "production_milestone" || command.kind === "quality_inspection" || command.kind === "quality_group_inspection" || command.kind === "production_recovery") {
      const [production] = await tx.select().from(productionOrders).where(eq(productionOrders.id, command.targetId));
      if (!production) throw new NotFoundException("原生产单不存在");
      if (command.kind === "production_recovery" && command.input.originalProductionOrderId !== production.id) throw mismatch();
      orderId = production.orderId; lineIds = [production.orderLineId]; productionIds.push(production.id);
    } else if (command.kind === "whole_production_milestone" || command.kind === "whole_quality_inspection" || command.kind === "whole_shipment_create") {
      orderId = command.targetId; lineIds = command.input.items.map(item => item.lineId);
      if (command.kind !== "whole_shipment_create") {
        const items = command.input.items;
        const rows = await tx.select().from(productionOrders).where(inArray(productionOrders.id, items.map(item => item.productionOrderId)));
        if (rows.length !== items.length || rows.some(row => row.orderId !== orderId || !items.some(item => item.productionOrderId === row.id && item.lineId === row.orderLineId))) throw mismatch();
        productionIds.push(...rows.map(row => row.id));
      }
    } else if (command.kind === "shipment_create") {
      orderId = command.targetId; lineIds = command.input.packages.flatMap(pkg => pkg.lines.map(line => line.orderLineId));
    } else {
      const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, command.targetId));
      if (!shipment) throw new NotFoundException("原发货单不存在");
      orderId = shipment.orderId;
      if (command.kind === "shipment_version") lineIds = command.input.packages.flatMap(pkg => pkg.lines.map(line => line.orderLineId));
      else {
        const [version] = await tx.select().from(shipmentVersions).where(and(eq(shipmentVersions.shipmentId, shipment.id),
          command.kind === "shipment_review" ? eq(shipmentVersions.id, command.versionId) : eq(shipmentVersions.versionNumber, command.input.expectedVersion)));
        if (!version) throw new NotFoundException("原包裹版本不存在");
        lineIds = (await tx.select({ id: shipmentPackageLines.orderLineId }).from(shipmentPackageLines).where(eq(shipmentPackageLines.shipmentVersionId, version.id))).map(row => row.id);
      }
    }
    lineIds = [...new Set(lineIds)].sort();
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
    const lines = lineIds.length ? await tx.select({ id: orderLines.id }).from(orderLines).where(and(eq(orderLines.orderId, orderId), inArray(orderLines.id, lineIds))) : [];
    if (!order || !lineIds.length || lineIds.length > 100 || lines.length !== lineIds.length) throw new NotFoundException("原订单商品不存在");
    if (order.addressStatus === "anonymized") throw new NotFoundException("原订单资料已清理");
    const [protectedDetail] = await tx.select({ expiresAt: orderProtectedDetails.retentionExpiresAt, status: orderProtectedDetails.status }).from(orderProtectedDetails).where(eq(orderProtectedDetails.orderId, orderId));
    const work = await tx.select({ expiresAt: orderWorkItems.expiresAt, key: orderWorkItems.encryptedDataKey }).from(orderWorkItems).where(inArray(orderWorkItems.id, lineIds));
    if (protectedDetail?.status === "anonymized" || work.some(row => !row.key)) throw new NotFoundException("原制作资料已清理");
    if (productionIds.length) {
      const versions = await tx.select({ projectId: productionOrderVersions.sourceEditorProjectId }).from(productionOrderVersions)
        .innerJoin(productionOrders, and(eq(productionOrders.id, productionOrderVersions.productionOrderId), eq(productionOrders.currentVersionNumber, productionOrderVersions.versionNumber)))
        .where(inArray(productionOrders.id, productionIds));
      projectIds.push(...versions.flatMap(row => row.projectId ? [row.projectId] : []));
    }
    if (productionVersionIds.length) {
      const versions = await tx.select({ projectId: productionOrderVersions.sourceEditorProjectId }).from(productionOrderVersions).where(inArray(productionOrderVersions.id, productionVersionIds));
      projectIds.push(...versions.flatMap(row => row.projectId ? [row.projectId] : []));
    }
    const projects = projectIds.length ? await tx.select({ expiresAt: productionEditorProjects.expiresAt, key: productionEditorProjects.encryptedDataKey }).from(productionEditorProjects).where(inArray(productionEditorProjects.id, [...new Set(projectIds)])) : [];
    if (projects.some(row => !row.key)) throw new NotFoundException("原制作文件已清理");
    const deadline = Math.min(...work.map(row => row.expiresAt.getTime()), ...(protectedDetail ? [protectedDetail.expiresAt.getTime()] : []),
      ...projects.flatMap(row => row.expiresAt ? [row.expiresAt.getTime()] : []));
    return { orderId, lineIds, deadline, summary: { orderNumber: order.externalOrderId, lineCount: lineIds.length, label: labels[command.kind] } };
  }

  async locate(tx: TenantTransaction, context: TenantContext, command: FulfillmentOwnerCommand): Promise<FulfillmentCommandReceipt | null> {
    const description = await this.describe(tx, context, command);
    const [clock] = await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`);
    if (description.deadline <= new Date(clock!.now).getTime()) throw new NotFoundException("原履约资料已到期");
    const parsed = (receipt: unknown) => FulfillmentCommandReceiptSchema.parse(receipt);
    switch (command.kind) {
      case "delivery_create": {
        const input = { ...command.input, items: [...command.input.items].sort((a, b) => a.productionOrderId.localeCompare(b.productionOrderId)) };
        const [row] = await tx.select().from(productionDeliveryPackages).where(eq(productionDeliveryPackages.idempotencyKey, input.idempotencyKey));
        if (!row) return null;
        const items = await tx.select().from(productionDeliveryItems).where(eq(productionDeliveryItems.packageId, row.id)).orderBy(asc(productionDeliveryItems.id));
        if (row.createdBy !== context.userId || row.requestChecksum !== sha(JSON.stringify(input)) || items.length !== input.items.length || items.some(item => !input.items.some(selection => selection.productionOrderId === item.productionOrderId && selection.productionVersionId === item.productionVersionId))) throw mismatch();
        return parsed({ kind: command.kind, packageId: row.id, itemIds: items.map(item => item.id), packageChecksum: row.checksum });
      }
      case "delivery_feedback": {
        const [row] = await tx.select().from(productionDeliveryFeedback).where(and(eq(productionDeliveryFeedback.itemId, command.targetId), eq(productionDeliveryFeedback.idempotencyKey, command.input.idempotencyKey)));
        if (!row) return null;
        if (row.recordedBy !== context.userId || row.requestChecksum !== sha(JSON.stringify(command.input))) throw mismatch();
        return parsed({ kind: command.kind, packageId: command.packageId, itemId: command.targetId, feedbackId: row.id, sequence: row.sequence });
      }
      case "production_milestone": {
        const [row] = await tx.select().from(productionMilestoneEvents).where(and(eq(productionMilestoneEvents.productionOrderId, command.targetId), eq(productionMilestoneEvents.externalEventId, command.input.externalEventId)));
        if (!row) return null;
        if (row.actorUserId !== context.userId || row.requestChecksum !== sha(JSON.stringify(command.input))) throw mismatch();
        return parsed({ kind: command.kind, productionOrderId: command.targetId, eventId: row.id, sequence: row.sequence });
      }
      case "quality_inspection": case "quality_group_inspection": {
        const [row] = await tx.select().from(qualityInspections).where(and(eq(qualityInspections.productionOrderId, command.targetId), eq(qualityInspections.idempotencyKey, command.input.idempotencyKey)));
        if (!row) return null;
        if (command.kind === "quality_inspection") {
          await assertInspectionReplay(tx, context, row, command.input);
          return parsed({ kind: command.kind, productionOrderId: command.targetId, inspectionId: row.id });
        }
        if (row.assessmentVersion !== 3 || row.inspectedBy !== context.userId || row.requestChecksum !== groupInspectionChecksum(context, command.input)) throw mismatch();
        const groups = await tx.select({ id: qualityInspectionGroups.id }).from(qualityInspectionGroups).where(eq(qualityInspectionGroups.inspectionId, row.id)).orderBy(asc(qualityInspectionGroups.id));
        return parsed({ kind: command.kind, productionOrderId: command.targetId, inspectionId: row.id, groupIds: groups.map(group => group.id) });
      }
      case "production_recovery": {
        const [row] = await tx.select().from(productionRecoveryCases).where(and(eq(productionRecoveryCases.originalProductionOrderId, command.targetId), eq(productionRecoveryCases.idempotencyKey, command.input.idempotencyKey)));
        if (!row) return null;
        await assertRecoveryReplay(tx, context, row, command.input, sha(JSON.stringify(command.input)));
        const children = await tx.select({ id: productionOrders.id }).from(productionOrders).where(and(eq(productionOrders.parentProductionOrderId, command.targetId), eq(productionOrders.idempotencyKey, `remake:${row.id}`)));
        if (command.input.type === "remake" && children.length !== 1 || command.input.type !== "remake" && children.length) throw mismatch();
        return parsed({ kind: command.kind, recoveryId: row.id, replacementProductionOrderId: children[0]?.id ?? null });
      }
      case "whole_production_milestone": {
        const input = { ...command.input, items: [...command.input.items].sort((a, b) => a.lineId.localeCompare(b.lineId)) };
        const prefix = `whole-order:${input.idempotencyKey}:`, key = prefix + sha(JSON.stringify({ orderId: command.targetId, input }));
        const rows = await tx.select().from(productionMilestoneEvents).where(like(productionMilestoneEvents.externalEventId, `${prefix}%`));
        if (!rows.length) return null;
        if (rows.length !== input.items.length || rows.some(row => row.externalEventId !== key || row.actorUserId !== context.userId || !input.items.some(item => item.productionOrderId === row.productionOrderId))) throw mismatch();
        return parsed({ kind: command.kind, items: rows.map(row => ({ productionOrderId: row.productionOrderId, eventId: row.id, sequence: row.sequence })).sort((a, b) => a.productionOrderId.localeCompare(b.productionOrderId)) });
      }
      case "whole_quality_inspection": {
        const input = { ...command.input, items: [...command.input.items].sort((a, b) => a.lineId.localeCompare(b.lineId)) };
        const prefix = `whole-order:${input.idempotencyKey}:`, key = prefix + sha(JSON.stringify({ orderId: command.targetId, input, ...(input.assessment ? { actor: context.userId } : {}) }));
        const rows = await tx.select().from(qualityInspections).where(like(qualityInspections.idempotencyKey, `${prefix}%`));
        if (!rows.length) return null;
        if (rows.length !== input.items.length || rows.some(row => row.idempotencyKey !== key || row.inspectedBy !== context.userId || !input.items.some(item => item.productionOrderId === row.productionOrderId))) throw mismatch();
        for (const row of rows) {
          const item = input.items.find(candidate => candidate.productionOrderId === row.productionOrderId)!;
          await assertInspectionReplay(tx, context, row, { assessment: input.assessment, expectedProductionProjectionVersion: item.expectedProductionProjectionVersion,
            qualityStandardVersionId: input.qualityStandardVersionId, scoreBps: input.scoreBps, inspectedAt: input.inspectedAt, evidenceAssetIds: input.evidenceAssetIds,
            result: "passed", defects: [], idempotencyKey: key });
        }
        return parsed({ kind: command.kind, items: rows.map(row => ({ productionOrderId: row.productionOrderId, inspectionId: row.id })).sort((a, b) => a.productionOrderId.localeCompare(b.productionOrderId)) });
      }
      case "shipment_create": case "whole_shipment_create": {
        const key = command.kind === "whole_shipment_create" ? `whole-order:${command.input.idempotencyKey}` : command.input.idempotencyKey;
        const [row] = await tx.select().from(shipments).where(and(eq(shipments.orderId, command.targetId), eq(shipments.idempotencyKey, key)));
        if (!row) return null;
        const [version] = await tx.select().from(shipmentVersions).where(and(eq(shipmentVersions.shipmentId, row.id), eq(shipmentVersions.versionNumber, 1)));
        if (!version || row.createdBy !== context.userId || version.createdBy !== context.userId) throw mismatch();
        if (command.kind === "shipment_create") await assertShipmentVersionReplay(tx, context, row.id, command.input, 1);
        else {
          const input = { ...command.input, items: [...command.input.items].sort((a, b) => a.lineId.localeCompare(b.lineId)) };
          if (version.idempotencyKey !== `${key}:${sha(JSON.stringify({ orderId: command.targetId, input }))}`) throw mismatch();
        }
        return parsed({ kind: command.kind, shipmentId: row.id, versionId: version.id, versionNumber: 1 });
      }
      case "shipment_version": {
        const [row] = await tx.select().from(shipmentVersions).where(and(eq(shipmentVersions.shipmentId, command.targetId), eq(shipmentVersions.idempotencyKey, command.input.idempotencyKey)));
        if (!row) return null;
        await assertShipmentVersionReplay(tx, context, command.targetId, command.input, row.versionNumber);
        return parsed({ kind: command.kind, shipmentId: command.targetId, versionId: row.id, versionNumber: row.versionNumber });
      }
      case "shipment_review": {
        const [row] = await tx.select().from(shipmentVersionReviews).where(and(eq(shipmentVersionReviews.shipmentId, command.targetId), eq(shipmentVersionReviews.idempotencyKey, command.input.idempotencyKey)));
        if (!row) return null;
        const [version] = await tx.select().from(shipmentVersions).where(and(eq(shipmentVersions.shipmentId, command.targetId), eq(shipmentVersions.id, row.shipmentVersionId)));
        if (row.shipmentVersionId !== command.versionId || row.reviewedBy !== context.userId || row.decision !== command.input.decision || row.reasonCode !== command.input.reasonCode || row.reasonChecksum !== sha(command.input.reason) || version?.versionNumber !== command.input.expectedCurrentVersion) throw mismatch();
        return parsed({ kind: command.kind, shipmentId: command.targetId, reviewId: row.id, versionId: row.shipmentVersionId });
      }
      case "shipment_dispatch": {
        const prefix = command.input.idempotencyKey, detail = `HANDOVER_${sha(JSON.stringify(command.input))}`;
        const rows = await tx.select().from(shipmentTrackingEvents).where(and(eq(shipmentTrackingEvents.shipmentId, command.targetId), sql`(${shipmentTrackingEvents.externalEventId}=${prefix} or starts_with(${shipmentTrackingEvents.externalEventId},${prefix + ":"}))`));
        if (!rows.length) return null;
        const [version] = await tx.select().from(shipmentVersions).where(and(eq(shipmentVersions.shipmentId, command.targetId), eq(shipmentVersions.versionNumber, command.input.expectedVersion)));
        const packages = version ? await tx.select({ id: shipmentPackageLines.packageId }).from(shipmentPackageLines).where(eq(shipmentPackageLines.shipmentVersionId, version.id)) : [];
        const expectedPackages = new Set(packages.map(pkg => pkg.id)), actualPackages = new Set(rows.map(row => row.packageId));
        const expectedKeys = new Set(Array.from({ length: expectedPackages.size }, (_, index) => index ? `${prefix}:${index}` : prefix));
        // The original dispatch owner also recognizes pre-recordedBy history
        // through its actual work event. Never infer that actor from this call.
        const oldEvents = rows.some(row => row.recordedBy === null) ? await tx.select({ actor: orderWorkEvents.actorId, hash: orderWorkEvents.requestHash, action: orderWorkEvents.action })
          .from(orderWorkEvents).where(and(eq(orderWorkEvents.idempotencyKey, prefix), inArray(orderWorkEvents.workItemId, description.lineIds))).limit(101) : [];
        const legacyActorMatches = oldEvents.length > 0 && oldEvents.length <= 100 && oldEvents.every(event => event.actor === context.userId && event.action === "dispatch" &&
          (event.hash === null || event.hash === sha(JSON.stringify(command.input))));
        if (!version || rows.length !== expectedPackages.size || actualPackages.size !== expectedPackages.size ||
          new Set(rows.map(row => row.externalEventId)).size !== expectedKeys.size ||
          rows.some(row => !row.packageId || !expectedPackages.has(row.packageId) || !expectedKeys.has(row.externalEventId) || (row.recordedBy === null ? !legacyActorMatches : row.recordedBy !== context.userId) ||
            row.detailCode !== detail || row.provider !== "manual" || row.status !== "picked_up")) throw mismatch();
        return parsed({ kind: command.kind, shipmentId: command.targetId, trackingEventIds: rows.map(row => row.id).sort() });
      }
      case "shipment_platform_confirmation": {
        const [row] = await tx.select().from(shipmentManualConfirmations).where(and(eq(shipmentManualConfirmations.shipmentId, command.targetId), eq(shipmentManualConfirmations.idempotencyKey, command.input.idempotencyKey)));
        if (!row) return null;
        const [version] = await tx.select().from(shipmentVersions).where(and(eq(shipmentVersions.shipmentId, command.targetId), eq(shipmentVersions.id, row.shipmentVersionId)));
        if (row.recordedBy !== context.userId || row.requestHash !== sha(JSON.stringify(command.input)) || version?.versionNumber !== command.input.expectedVersion) throw mismatch();
        return parsed({ kind: command.kind, shipmentId: command.targetId, confirmationId: row.id, versionId: row.shipmentVersionId });
      }
    }
  }

  async execute(context: TenantContext, command: FulfillmentOwnerCommand, fence: OrderFulfillmentCommandFence): Promise<void> {
    switch (command.kind) {
      case "delivery_create": await this.delivery.create(context, command.input, fence, command.targetId); break;
      case "delivery_feedback": await this.delivery.recordFeedback(context, command.packageId, command.targetId, command.input, fence); break;
      case "production_milestone": await this.production.recordMilestone(context, command.targetId, command.input, fence); break;
      case "quality_inspection": await this.production.inspect(context, command.targetId, command.input, fence); break;
      case "quality_group_inspection": await this.production.inspectGroups(context, command.targetId, command.input, fence); break;
      case "production_recovery": await this.production.recover(context, command.input, fence); break;
      case "whole_production_milestone": await this.production.recordWholeOrderProduction(context, command.targetId, command.input, fence); break;
      case "whole_quality_inspection": await this.production.inspectWholeOrder(context, command.targetId, command.input, fence); break;
      case "shipment_create": await this.shipment.create(context, command.targetId, command.input, fence); break;
      case "whole_shipment_create": await this.shipment.createWholeOrder(context, command.targetId, command.input, fence); break;
      case "shipment_version": await this.shipment.appendVersion(context, command.targetId, command.input, fence); break;
      case "shipment_review": await this.shipment.reviewVersion(context, command.targetId, command.versionId, command.input, fence); break;
      case "shipment_dispatch": await this.shipment.dispatch(context, command.targetId, command.input, fence); break;
      case "shipment_platform_confirmation": await this.shipment.recordManualConfirmation(context, command.targetId, command.input, fence); break;
    }
  }
}
