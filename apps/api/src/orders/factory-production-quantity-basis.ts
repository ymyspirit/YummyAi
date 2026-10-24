import { createHash } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { FactoryQuantityAccessViewSchema, FactoryQuantityBasisSchema } from "@yummyai/contracts/suppliers/factory-quantity";
import {
  productionOrders, productionOrderVersions, productionQuantityReviews,
  type TenantTransaction,
} from "@yummyai/database";
import { and, desc, eq, sql } from "drizzle-orm";
import { factoryPortalAuthority } from "./factory-access.js";
import type { OrderProductionDeliveryService } from "./order-production-delivery.service.js";
import { readProductionQuantityBasis } from "./production-quantity-basis.js";

/** Internal only: neither the delivery snapshot nor the operator basis is a factory DTO. */
export type FactoryQuantityTaskSource = Awaited<ReturnType<OrderProductionDeliveryService["factoryQuantitySourceInTransaction"]>>;

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

export async function readFactoryQuantityTask(tx: TenantTransaction, context: TenantContext, source: FactoryQuantityTaskSource) {
  const { scope, pin } = source;
  const [version] = await tx.select({ id: productionOrderVersions.id, versionNumber: productionOrderVersions.versionNumber,
    quantity: productionOrderVersions.quantity, factoryId: productionOrderVersions.factoryId }).from(productionOrderVersions)
    .where(and(eq(productionOrderVersions.id, scope.item.productionVersionId), eq(productionOrderVersions.productionOrderId, scope.item.productionOrderId)));
  const [production] = await tx.select({ currentVersionNumber: productionOrders.currentVersionNumber, factoryId: productionOrders.factoryId })
    .from(productionOrders).where(eq(productionOrders.id, scope.item.productionOrderId));
  if (!version || !production) throw new NotFoundException({ code: "factory_quantity_not_found", message: "工厂任务不存在或授权已失效" });

  const latest = source.acceptedFeedback;
  const acceptedFeedbackId = source.selfAccepted && latest?.kind === "accepted" ? latest.id : null;
  const manufacturing = pin?.manufacturing ?? null;
  const blockers: string[] = [];
  if (!source.privateCurrent || !pin || source.blockers.length)
    blockers.push("原制作文件或来源暂不可用 请联系运营核对");
  if (production.currentVersionNumber !== version.versionNumber || production.factoryId !== scope.package.factoryId ||
      version.factoryId !== scope.package.factoryId || pin && (pin.productionVersionId !== version.id || pin.quantity !== version.quantity))
    blockers.push("原生产版本或工厂已变化 请联系运营重新交付");
  if (!manufacturing || manufacturing.plan.quantity !== version.quantity || manufacturing.bindingId !== scope.item.manufacturingBindingId ||
      manufacturing.sourceContentChecksum !== scope.item.manufacturingContentChecksum || manufacturing.plan.checksum !== scope.item.manufacturingPlanChecksum)
    blockers.push("原任务缺少可核对的整张生产制造依据");
  if (!acceptedFeedbackId) blockers.push("请先使用本人任务接受原生产文件及制造清单");

  const taskFingerprint = hash({ version: 1, tenantId: context.tenantId, userId: context.userId,
    contextAuthority: factoryPortalAuthority(context), assignmentId: scope.assignment.id, grantId: scope.grant.id,
    membershipId: scope.grant.membershipId, assignmentExpiresAt: scope.assignment.expiresAt.toISOString(), grantExpiresAt: scope.grant.expiresAt.toISOString(),
    canRespond: scope.grant.canRespond, deliveryItemId: scope.item.id, factoryId: scope.package.factoryId,
    productionVersionId: version.id, currentVersionNumber: production.currentVersionNumber,
    currentFactoryId: production.factoryId, workRevisionId: scope.item.workRevisionId, editorVersionId: scope.item.editorVersionId, renderId: scope.item.renderId,
    fileChecksum: scope.item.fileChecksum, manufacturingChecksum: manufacturing?.plan.checksum ?? null,
    latestFeedbackId: latest?.id ?? null, latestFeedbackKind: latest?.kind ?? null, latestFeedbackSequence: latest?.sequence ?? null,
    acceptedFeedbackId, privateCurrent: source.privateCurrent, blockers });
  const canReport = context.permissions.includes(Permission.FactoryTaskRead) && context.permissions.includes(Permission.FactoryTaskRespond) && scope.grant.canRespond;
  return { source, version, acceptedFeedbackId, manufacturing, blockers, taskFingerprint, canReport };
}

export type FactoryQuantityTask = Awaited<ReturnType<typeof readFactoryQuantityTask>>;

export function factoryQuantityAccess(context: TenantContext, task: FactoryQuantityTask, canReport = task.canReport) {
  return FactoryQuantityAccessViewSchema.parse({ assignmentId: task.source.scope.assignment.id,
    contextAuthority: factoryPortalAuthority(context), taskFingerprint: task.taskFingerprint, access: { canRead: true, canReport } });
}

export async function readFactoryProductionQuantityBasis(tx: TenantTransaction, context: TenantContext, task: FactoryQuantityTask) {
  const internal = await readProductionQuantityBasis(tx, context, task.source.scope.item.productionOrderId);
  const [fingerprint] = await tx.execute<{ fingerprint: string | null }>(sql`
    select factory_quantity_basis_fingerprint(${context.tenantId}::uuid,${context.userId}::uuid,${task.source.scope.assignment.id}::uuid) as fingerprint`);
  if (!fingerprint?.fingerprint)
    throw new NotFoundException({ code: "factory_quantity_not_found", message: "工厂任务不存在或授权已失效" });
  const sameVersion = internal.productionVersionId === task.version.id;
  const [prior] = sameVersion ? [] : await tx.select({ quantities: productionQuantityReviews.quantities, cumulativeStoppedQuantity: productionQuantityReviews.cumulativeStoppedQuantity })
    .from(productionQuantityReviews).where(and(eq(productionQuantityReviews.productionOrderId, task.source.scope.item.productionOrderId),
      eq(productionQuantityReviews.productionVersionId, task.version.id))).orderBy(desc(productionQuantityReviews.sequence)).limit(1);
  const blockers = [...task.blockers];
  if (!sameVersion && !blockers.length) blockers.push("原生产版本已变化 请联系运营重新交付");
  if (internal.blockers.length) blockers.push("当前生产数量依据待运营核对 暂不能提交工厂清点报告");
  const basis = FactoryQuantityBasisSchema.parse({ scope: "full_production_version", quantity: task.version.quantity,
    unit: task.manufacturing?.plan.unit ?? null, versionNumber: task.version.versionNumber,
    fileChecksum: task.source.scope.item.fileChecksum, manufacturingChecksum: task.manufacturing?.plan.checksum ?? null,
    acceptedFeedbackId: task.acceptedFeedbackId,
    stoppedQuantity: sameVersion ? internal.cumulativeStoppedQuantity : prior?.cumulativeStoppedQuantity ?? 0,
    approvedQuantities: sameVersion ? internal.currentQuantities : prior?.quantities ?? null,
    fingerprint: fingerprint.fingerprint, blockers: [...new Set(blockers)] });
  return { internal, basis, canReport: task.canReport && sameVersion && !basis.blockers.length && !!basis.unit };
}
